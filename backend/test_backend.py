"""
Integration tests for the chess analysis backend.

Assumes the Flask server from app.py is running at BACKEND_URL.
Covers:
  - Health and home endpoints
  - Basic analysis from FEN
  - Determinism (same FEN returns the same best move) -- regression test for
    the repetition-avoidance bug that used to swap the best move on repeat calls
  - Cache metadata on repeated calls
  - Analysis from move list
  - Mate-in-one detection
  - Invalid inputs
  - sideToMove forcing
"""

import sys
import time

import chess
import requests

BACKEND_URL = "http://localhost:5000"
REQUEST_TIMEOUT = 60  # seconds; engine depth-22 can take a while

PASS = "PASS"
FAIL = "FAIL"

results = []


def record(name, ok, detail=""):
    results.append((name, ok, detail))
    marker = PASS if ok else FAIL
    print(f"[{marker}] {name}" + (f" -- {detail}" if detail else ""))


def post_analyze(payload):
    return requests.post(
        f"{BACKEND_URL}/analyze",
        json=payload,
        timeout=REQUEST_TIMEOUT,
    )


def is_legal_san(fen, san):
    try:
        board = chess.Board(fen)
        board.parse_san(san)
        return True
    except Exception:
        return False


def test_health():
    r = requests.get(f"{BACKEND_URL}/health", timeout=10)
    ok = r.status_code == 200 and r.json().get("status") == "ok"
    record("health endpoint reports ok", ok, r.text.strip()[:120] if not ok else "")
    engine_ok = bool(r.json().get("engine_available"))
    record("stockfish engine available", engine_ok)
    return ok and engine_ok


def test_home():
    r = requests.get(f"{BACKEND_URL}/", timeout=10)
    ok = r.status_code == 200 and "Chess Analysis" in r.json().get("name", "")
    record("home endpoint returns metadata", ok)


def test_basic_analyze():
    fen = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"
    r = post_analyze({"fen": fen, "depth": 12})
    if r.status_code != 200:
        record("analyze: after 1.e4 returns 200", False, r.text[:120])
        return None
    data = r.json()
    move = data.get("bestMoveSAN")
    legal = move and is_legal_san(fen, move)
    record(
        "analyze: after 1.e4 returns a legal black reply",
        bool(legal),
        f"move={move} eval={data.get('evaluation')}",
    )
    return data


def test_determinism():
    """
    Regression test: before the fix, the backend's repetition-avoidance
    branch would pick a different move when the same FEN was sent twice
    within the 30s cache window. Now, identical FEN must return identical
    best move every time.
    """
    fen = "rnbqkb1r/pppp1ppp/5n2/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"
    moves_seen = []
    for i in range(3):
        r = post_analyze({"fen": fen, "depth": 12})
        if r.status_code != 200:
            record(f"determinism call {i+1} succeeded", False, r.text[:120])
            return
        moves_seen.append(r.json().get("bestMoveSAN"))
        time.sleep(0.3)

    ok = len(set(moves_seen)) == 1 and moves_seen[0] is not None
    record(
        "determinism: same FEN -> same best move across 3 calls",
        ok,
        f"moves_seen={moves_seen}",
    )


def test_cache_metadata():
    """
    Second call for the same FEN within 30s should be served from cache
    and return cached=true with a positive cache_age.
    """
    fen = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"
    r1 = post_analyze({"fen": fen, "depth": 12})
    if r1.status_code != 200:
        record("cache: first call ok", False, r1.text[:120])
        return
    time.sleep(0.5)
    r2 = post_analyze({"fen": fen, "depth": 12})
    if r2.status_code != 200:
        record("cache: second call ok", False, r2.text[:120])
        return
    d2 = r2.json()
    cached = d2.get("cached") is True and float(d2.get("cache_age", 0)) > 0
    record(
        "cache: second call flagged cached with cache_age",
        cached,
        f"cached={d2.get('cached')} cache_age={d2.get('cache_age')}",
    )
    # The confusing note from the old code should be gone.
    record(
        "cache: no misleading 'consider exploring different moves' note",
        "analysis_note" not in d2,
    )
    # Both responses should point to the same best move.
    same = r1.json().get("bestMoveSAN") == d2.get("bestMoveSAN")
    record(
        "cache: cached response matches original best move",
        same,
        f"{r1.json().get('bestMoveSAN')} vs {d2.get('bestMoveSAN')}",
    )


def test_moves_input():
    r = post_analyze({"moves": ["e4", "e5", "Nf3", "Nc6"], "depth": 10})
    if r.status_code != 200:
        record("analyze from moves list", False, r.text[:120])
        return
    d = r.json()
    move = d.get("bestMoveSAN")
    fen = d.get("fen")
    ok = move and fen and is_legal_san(fen, move)
    record(
        "analyze: move-list input returns legal move for reconstructed position",
        bool(ok),
        f"move={move} turn={d.get('turn')}",
    )


def test_mate_in_one():
    # Scholar's mate setup: white to play Qxf7#
    fen = "r1bqkbnr/pppp1Qpp/2n5/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4"
    # Position is actually after 1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? 4.Qxf7# -- but that's already mate.
    # Use a pre-mate position: white to move, mate in 1 with Qxf7#.
    fen = "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 2 3"
    r = post_analyze({"fen": fen, "depth": 14})
    if r.status_code != 200:
        record("mate-in-one: request ok", False, r.text[:120])
        return
    d = r.json()
    move = d.get("bestMoveSAN")
    # Accept either Qxf7# (the known mate) or any mate-announcing evaluation.
    evaluation = d.get("evaluation", "")
    ok = (move == "Qxf7#") or evaluation.startswith("M")
    record(
        "mate-in-one: engine sees mate (Qxf7# or M-score)",
        ok,
        f"move={move} eval={evaluation}",
    )


def test_invalid_fen():
    r = post_analyze({"fen": "not-a-real-fen-at-all", "depth": 10})
    record(
        "invalid FEN returns 4xx",
        400 <= r.status_code < 500,
        f"status={r.status_code}",
    )


def test_missing_payload():
    r = post_analyze({})
    record(
        "empty payload returns 4xx",
        400 <= r.status_code < 500,
        f"status={r.status_code}",
    )


def test_side_to_move_forcing():
    """
    Passing sideToMove='b' against a starting-position FEN should make the
    engine analyze as if it were black to move.
    """
    fen = chess.STARTING_FEN
    r = post_analyze({"fen": fen, "sideToMove": "b", "depth": 10})
    if r.status_code != 200:
        record("sideToMove forcing: request ok", False, r.text[:120])
        return
    d = r.json()
    record(
        "sideToMove='b' makes engine treat position as black-to-move",
        d.get("turn") == "black",
        f"turn={d.get('turn')} move={d.get('bestMoveSAN')}",
    )


def main():
    print(f"Testing backend at {BACKEND_URL}\n")
    try:
        if not test_health():
            print("\nBackend is not healthy; aborting remaining tests.")
            sys.exit(2)
    except requests.RequestException as e:
        print(f"Could not reach backend: {e}")
        sys.exit(2)

    test_home()
    test_basic_analyze()
    test_determinism()
    test_cache_metadata()
    test_moves_input()
    test_mate_in_one()
    test_invalid_fen()
    test_missing_payload()
    test_side_to_move_forcing()

    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"\n{passed}/{total} checks passed")
    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    main()
