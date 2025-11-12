import requests
import json

# Test the backend with a simple position
test_fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'
payload = {
    'fen': test_fen,
    'sideToMove': 'b'
}

try:
    response = requests.post('http://localhost:5000/analyze', json=payload)
    if response.status_code == 200:
        result = response.json()
        print('SUCCESS: Backend test passed')
        print(f'Best Move: {result.get("bestMoveSAN", "Unknown")}')
        print(f'Evaluation: {result.get("evaluation", "Unknown")}')
        print(f'Turn: {result.get("turn", "Unknown")}')
    else:
        print(f'ERROR: HTTP {response.status_code}')
        print(response.text)
except Exception as e:
    print(f'ERROR: {e}')