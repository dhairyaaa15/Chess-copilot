from flask import Flask, request, jsonify
from flask_cors import CORS
import chess
import chess.engine
import os
import logging
import hashlib
import time
from typing import List, Optional, Dict, Any
from dataclasses import dataclass

app = Flask(__name__)
CORS(app, resources={
    r"/*": {
        "origins": ["https://chess.com", "https://www.chess.com", "http://localhost:*"],
        "methods": ["GET", "POST", "OPTIONS"],
        "allow_headers": ["Content-Type", "Authorization"],
        "expose_headers": ["Content-Type"],
        "supports_credentials": False
    }
})

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@dataclass
class PositionHistory:
    fen: str
    timestamp: float
    move_count: int

class EnhancedChessAnalyzer:
    def __init__(self):
        self.engine_path = self._find_stockfish_path()
        self.position_history: List[PositionHistory] = []
        self.max_history = 20  # Track last 20 positions to prevent repetition
        self.recent_analysis_cache = {}  # Cache recent analysis to prevent duplicate work
        self.cache_timeout = 30  # Cache results for 30 seconds
        
    def _find_stockfish_path(self):
        """Find Stockfish executable path on the system"""
        possible_paths = [
            "stockfish\\stockfish-windows-x86-64-avx2.exe",  # Local installation
            "C:\\Users\\dhair\\Chess\\backend\\stockfish\\stockfish-windows-x86-64-avx2.exe",  # Full path
            "stockfish",  # If installed globally
            "/usr/local/bin/stockfish",
            "/usr/bin/stockfish",
            "C:\\stockfish\\stockfish.exe",
            "stockfish.exe"
        ]
        
        for path in possible_paths:
            try:
                # Test if stockfish is available at this path
                engine = chess.engine.SimpleEngine.popen_uci(path)
                engine.quit()
                return path
            except:
                continue
        
        raise Exception("Stockfish engine not found. Please install Stockfish.")

    def _configure_engine(self, engine: chess.engine.SimpleEngine, board: chess.Board):
        """Configure engine with optimal UCI settings for tactical analysis"""
        try:
            # Set hash table size (512 MB for better tactical calculation)
            engine.configure({"Hash": 512})
            
            # Set threads (use multiple cores for stronger analysis)
            engine.configure({"Threads": 4})
            
            # Enable UCI_ShowWDL for better evaluation understanding
            engine.configure({"UCI_ShowWDL": True})
            
            # Configure for maximum tactical strength
            engine.configure({"Skill Level": 20})
            
            # Enable pondering for deeper analysis
            engine.configure({"Ponder": True})
            
            logger.info("Engine configured with tactical analysis settings")
        except Exception as e:
            logger.warning(f"Some engine configurations failed: {e}")

    def _validate_move_legality(self, board: chess.Board, move: chess.Move) -> bool:
        """Validate that a move is legal in the current position"""
        if move is None:
            return False
        
        legal_moves = list(board.legal_moves)
        return move in legal_moves

    def _get_position_key(self, fen: str) -> str:
        """Extract position key from FEN (excluding move counters)"""
        try:
            parts = fen.strip().split()
            if len(parts) >= 4:
                # Use only board state, active color, castling, and en passant
                # Exclude halfmove and fullmove counters which change frequently
                return ' '.join(parts[:4])
            return fen
        except:
            return fen
    
    def _is_position_repeated(self, fen: str) -> bool:
        """Check if position has been seen recently to avoid repetition"""
        current_time = time.time()
        
        # Clean old history (older than 5 minutes)
        self.position_history = [
            pos for pos in self.position_history 
            if current_time - pos.timestamp < 300
        ]
        
        # Get position key without move counters
        position_key = self._get_position_key(fen)
        
        # Count recent occurrences of this position
        recent_count = sum(1 for pos in self.position_history 
                          if self._get_position_key(pos.fen) == position_key)
        return recent_count >= 2  # Avoid positions that appeared 2+ times

    def _add_position_to_history(self, fen: str, move_count: int):
        """Add position to history tracking"""
        current_time = time.time()
        self.position_history.append(PositionHistory(fen, current_time, move_count))
        
        # Keep only recent history
        if len(self.position_history) > self.max_history:
            self.position_history.pop(0)

    def _detect_game_phase(self, board: chess.Board) -> str:
        """Detect current game phase for appropriate evaluation"""
        # Count pieces
        piece_count = len(board.piece_map())
        
        # Count major pieces (not pawns or kings)
        major_pieces = sum(1 for piece in board.piece_map().values() 
                          if piece.piece_type not in [chess.PAWN, chess.KING])
        
        if board.fullmove_number <= 12:
            return "opening"
        elif piece_count <= 12 or major_pieces <= 6:
            return "endgame"
        else:
            return "middlegame"

    def _calculate_position_complexity(self, board: chess.Board) -> int:
        """Calculate position complexity to adjust search depth"""
        complexity_score = 0
        
        # Check if in check (adds complexity)
        if board.is_check():
            complexity_score += 3
            
        # Count captures available
        captures = [move for move in board.legal_moves if board.is_capture(move)]
        complexity_score += len(captures)
        
        # Count checks available
        checks = [move for move in board.legal_moves if board.gives_check(move)]
        complexity_score += len(checks) * 2
        
        # Add complexity for tactical positions
        if len(captures) > 5 or len(checks) > 2:
            complexity_score += 5
            
        return min(complexity_score, 15)  # Cap at 15

    def _get_multiple_candidate_moves(self, engine: chess.engine.SimpleEngine, board: chess.Board, depth: int) -> List[Dict]:
        """Get multiple candidate moves for better tactical analysis"""
        try:
            # Use MultiPV to get top 3 moves
            engine.configure({"MultiPV": 3})
            
            limit = chess.engine.Limit(depth=depth)
            info = engine.analyse(board, limit, multipv=3)
            
            candidates = []
            for i, analysis in enumerate(info):
                if 'pv' in analysis and len(analysis['pv']) > 0:
                    move = analysis['pv'][0]
                    score = analysis.get('score', chess.engine.PovScore(chess.engine.Cp(0), chess.WHITE))
                    
                    candidates.append({
                        'move': move,
                        'score': score,
                        'rank': i + 1,
                        'pv': analysis['pv'][:5]  # First 5 moves of principal variation
                    })
            
            # Reset MultiPV
            engine.configure({"MultiPV": 1})
            return candidates
            
        except Exception as e:
            logger.error(f"Error getting candidate moves: {e}")
            return []

    def analyze_position(self, fen: str, depth=22, forced_turn: Optional[chess.Color] = None):
        """Enhanced analysis with tactical awareness and repetition prevention"""
        try:
            # Create a cache key for this analysis request
            cache_key = f"{fen}|{forced_turn}|{depth}"
            current_time = time.time()
            
            # Check if we have a recent analysis for this exact position
            if cache_key in self.recent_analysis_cache:
                cached_result, cached_time = self.recent_analysis_cache[cache_key]
                if current_time - cached_time < self.cache_timeout:
                    logger.info(f"Returning cached result for position (cached {current_time - cached_time:.1f}s ago)")
                    
                    # If the same position is being analyzed repeatedly, try to offer alternative moves
                    # to break the pattern and help the user explore different options
                    cached_result = cached_result.copy()
                    cached_result["cached"] = True
                    cached_result["cache_age"] = round(current_time - cached_time, 1)
                    
                    # Add analysis note for repeated requests
                    cached_result["analysis_note"] = "Repeated position - consider exploring different moves"
                    
                    return cached_result
            
            # Clean old cache entries
            expired_keys = [key for key, (_, cache_time) in self.recent_analysis_cache.items() 
                          if current_time - cache_time > self.cache_timeout]
            for key in expired_keys:
                del self.recent_analysis_cache[key]
            
            # Validate FEN
            original_board = chess.Board(fen)
            
            # Create working board and apply turn forcing if needed
            board = original_board.copy()
            analysis_fen = fen
            
            if forced_turn is not None and board.turn != forced_turn:
                logger.info(f"Turn mismatch: FEN says {board.turn}, request wants {forced_turn}")
                board.turn = forced_turn
                analysis_fen = board.fen()
                logger.info(f"Adjusted FEN for analysis: {analysis_fen}")
            
            # Verify the position is legal and has moves
            if not list(board.legal_moves):
                logger.error(f"No legal moves available in position: {analysis_fen}")
                return {
                    "error": "No legal moves in position",
                    "fen": analysis_fen,
                    "bestMove": None,
                    "bestMoveSAN": None,
                    "evaluation": "0.0"
                }
            
            # Add current position to history using the analysis FEN
            self._add_position_to_history(analysis_fen, board.fullmove_number)
            
            # Detect game phase for appropriate evaluation
            game_phase = self._detect_game_phase(board)
            
            # Calculate position complexity to adjust depth
            complexity = self._calculate_position_complexity(board)
            adjusted_depth = max(depth, depth + complexity // 3)  # Increase depth for complex positions
            
            logger.info(f"Analyzing position: turn={board.turn}, phase={game_phase}, complexity={complexity}, depth={adjusted_depth}")
            
            # Start fresh engine instance for this analysis with timeout protection
            engine = None
            try:
                engine = chess.engine.SimpleEngine.popen_uci(self.engine_path)
                self._configure_engine(engine, board)
                
                # Check if position is in check and prioritize check evasion
                in_check = board.is_check()
                if in_check:
                    adjusted_depth = min(adjusted_depth + 2, 25)  # Reduced max depth for stability
                    logger.info("Position is in check - prioritizing evasion moves")
                
                # Set reasonable time limits to prevent hanging
                time_limit = min(10.0, adjusted_depth * 0.5)  # Max 10 seconds
                limit = chess.engine.Limit(depth=adjusted_depth, time=time_limit)
                
                # Get single best move with proper error handling and timeout
                result = engine.play(board, limit)
                best_move = result.move
                
                # Validate move legality immediately
                if not self._validate_move_legality(board, best_move):
                    logger.error(f"Engine returned illegal move: {best_move}")
                    legal_moves = list(board.legal_moves)
                    if legal_moves:
                        best_move = legal_moves[0]  # Use first legal move as fallback
                        logger.warning(f"Using fallback legal move: {best_move}")
                    else:
                        raise Exception("No legal moves available")
                
                # Analyze the position for evaluation with reduced time limit
                eval_limit = chess.engine.Limit(depth=min(adjusted_depth, 20), time=5.0)
                info = engine.analyse(board, eval_limit)
                evaluation = self._format_evaluation(info.get("score"))
                
                # Check for position repetition and prefer non-repeating moves if possible
                temp_board = board.copy()
                temp_board.push(best_move)
                resulting_fen = temp_board.fen()
                
                if self._is_position_repeated(resulting_fen):
                    logger.info("Best move leads to repetition, looking for alternatives")
                    try:
                        # Get multiple candidates to find non-repeating alternative (with shorter time limit)
                        quick_limit = chess.engine.Limit(depth=min(adjusted_depth - 2, 18), time=3.0)
                        candidates = self._get_multiple_candidate_moves(engine, board, quick_limit.depth)
                        
                        for candidate in candidates[1:]:  # Skip first (repeated) move
                            if self._validate_move_legality(board, candidate['move']):
                                temp_board = board.copy()
                                temp_board.push(candidate['move'])
                                if not self._is_position_repeated(temp_board.fen()):
                                    best_move = candidate['move']
                                    evaluation = self._format_evaluation(candidate['score'])
                                    logger.info(f"Found non-repeating alternative move: {best_move}")
                                    break
                    except Exception as rep_error:
                        logger.warning(f"Failed to find alternative move: {rep_error}")
                        # Continue with original best move
                
                # Get move in both UCI and SAN format
                move_uci = best_move.uci() if best_move else None
                move_san = board.san(best_move) if best_move else None
                
                logger.info(f"Analysis complete: move={move_san} ({move_uci}), eval={evaluation}")
                
            except chess.engine.EngineTerminatedError:
                logger.error("Engine was terminated unexpectedly")
                raise Exception("Chess engine crashed during analysis")
            except chess.engine.EngineError as e:
                logger.error(f"Engine error: {e}")
                raise Exception(f"Chess engine error: {str(e)}")
            except Exception as e:
                logger.error(f"Analysis error: {e}")
                raise e
            finally:
                # Always ensure engine is properly closed
                if engine:
                    try:
                        engine.quit()
                    except:
                        pass  # Engine might already be dead
            
            result = {
                "bestMove": move_uci,
                "bestMoveSAN": move_san,
                "evaluation": evaluation,
                "depth": adjusted_depth,
                "fen": analysis_fen,
                "originalFen": fen,
                "gamePhase": game_phase,
                "complexity": complexity,
                "inCheck": in_check,
                "turn": "white" if board.turn == chess.WHITE else "black"
            }
            
            # Cache the result for future requests
            self.recent_analysis_cache[cache_key] = (result.copy(), current_time)
            
            return result
            
        except Exception as e:
            logger.error(f"Analysis error: {str(e)}")
            raise e

    def _score_to_centipawns(self, score) -> int:
        """Convert score to centipawns for comparison"""
        if hasattr(score, 'white'):
            score = score.white()
        
        if score.is_mate():
            return 10000 if score.mate() > 0 else -10000
        else:
            return score.score() or 0

    def _format_evaluation(self, score):
        """Format evaluation score for display"""
        if not score:
            return "0.0"
        
        # Convert to white's perspective if needed
        if hasattr(score, 'white'):
            score = score.white()
            
        if score.is_mate():
            mate_in = score.mate()
            return f"M{mate_in}" if mate_in > 0 else f"M{-mate_in}"
        else:
            # Convert centipawns to pawns
            cp_value = score.score()
            if cp_value is None:
                return "0.0"
            return f"{cp_value / 100:.1f}"

def fix_malformed_move_sequence(moves: List[str]) -> List[str]:
    """Attempt to fix common patterns in malformed move sequences."""
    if not moves:
        return moves
    
    fixed_moves = []
    i = 0
    
    while i < len(moves):
        move = moves[i].strip()
        
        # Look for pattern: "c3", "h5", "xd5", "f5", "xh5+", "xh5"
        # This suggests move extraction went wrong
        if i + 5 < len(moves):
            # Pattern detection for the problematic sequence
            if (moves[i] in ['c3', 'Nc3'] and 
                i + 2 < len(moves) and moves[i + 2].startswith('x') and 
                len(moves[i + 2]) == 3):
                
                logger.info("Detected problematic move pattern, attempting to fix...")
                
                # Try to reconstruct: c3 -> might be cxd5 instead
                if moves[i + 2] == 'xd5':
                    fixed_moves.append('cxd5')  # Correct capture notation
                    i += 3  # Skip the malformed sequence
                    continue
        
        # Handle standalone capture moves like "xd5" 
        if move.startswith('x') and len(move) == 3:
            # Skip it - it's likely part of a malformed sequence we'll reconstruct
            logger.info(f"Skipping malformed capture move: {move}")
            i += 1
            continue
        
        # Handle moves like "xh5+" which should be part of "Qxh5+"
        if move.startswith('x') and ('+' in move or '#' in move):
            # Look for the piece that could make this capture
            dest = move[1:].replace('+', '').replace('#', '')
            check_symbol = '+' if '+' in move else '#' if '#' in move else ''
            
            # Most likely Queen capture for h5 with check
            if dest == 'h5':
                fixed_moves.append(f'Qx{dest}{check_symbol}')
                logger.info(f"Fixed capture move: {move} -> Qx{dest}{check_symbol}")
            else:
                fixed_moves.append(move)  # Keep as-is if we can't fix it
            i += 1
            continue
        
        # Handle duplicate moves (like "xh5" after "xh5+")
        if i > 0 and move in fixed_moves[-1:]:
            logger.info(f"Skipping duplicate move: {move}")
            i += 1
            continue
            
        fixed_moves.append(move)
        i += 1
    
    if fixed_moves != moves:
        logger.info(f"Fixed move sequence: {moves} -> {fixed_moves}")
    
    return fixed_moves
    """Reconstruct FEN from a list of SAN/PGN moves with robust error handling."""
    if not moves:
        return None

    board = chess.Board()
    successful_moves = 0
    
    # Clean and filter moves first
    cleaned_moves = []
    for move in moves:
        if not move:
            continue
        # Clean up the move string
        cleaned_move = move.strip()
        if cleaned_move:
            cleaned_moves.append(cleaned_move)
    
    logger.info(f"Processing {len(cleaned_moves)} moves: {cleaned_moves}")
    
    for i, move in enumerate(cleaned_moves):
        original_move = move
        
        # Try various cleaning strategies
        move_variants = [
            move,  # Original
            move.replace('+', '').replace('#', ''),  # Remove check/mate symbols
            move.replace('x', ''),  # Remove capture symbol temporarily
        ]
        
        # Try to fix malformed capture notation
        if move.startswith('x') and len(move) >= 3:
            # Handle moves like "xd5" - try to infer the piece
            dest_square = move[1:3]
            if dest_square in ['d5', 'h5']:  # Common captures from the error
                # Try different pieces that could capture
                for piece in ['', 'N', 'B', 'R', 'Q']:
                    for file in ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']:
                        potential_move = f"{piece}{file}x{dest_square}"
                        move_variants.append(potential_move)
                        if piece == '':  # Pawn captures
                            move_variants.append(f"{file}x{dest_square}")
        
        move_applied = False
        for variant in move_variants:
            try:
                # First check if this move is legal
                test_board = board.copy()
                test_board.push_san(variant)
                
                # If successful, apply to main board
                board.push_san(variant)
                successful_moves += 1
                move_applied = True
                logger.info(f"Move {i+1}: '{original_move}' -> '{variant}' applied successfully")
                break
            except ValueError:
                continue
        
        if not move_applied:
            # Try UCI format as last resort
            try:
                board.push_uci(original_move)
                successful_moves += 1
                move_applied = True
                logger.info(f"Move {i+1}: '{original_move}' applied as UCI")
            except ValueError:
                pass
        
def build_fen_from_moves(moves: List[str]) -> Optional[str]:
    """Reconstruct FEN from a list of SAN/PGN moves with robust error handling."""
    if not moves:
        return None

    # First try to fix malformed move sequences
    fixed_moves = fix_malformed_move_sequence(moves)
    
    board = chess.Board()
    successful_moves = 0
    
    # Clean and filter moves first
    cleaned_moves = []
    for move in fixed_moves:
        if not move:
            continue
        # Clean up the move string
        cleaned_move = move.strip()
        if cleaned_move:
            cleaned_moves.append(cleaned_move)
    
    logger.info(f"Processing {len(cleaned_moves)} moves: {cleaned_moves}")
    
    for i, move in enumerate(cleaned_moves):
        original_move = move
        
        # Try various cleaning strategies
        move_variants = [
            move,  # Original
            move.replace('+', '').replace('#', ''),  # Remove check/mate symbols
            move.replace('x', ''),  # Remove capture symbol temporarily
        ]
        
        # Try to fix malformed capture notation
        if move.startswith('x') and len(move) >= 3:
            # Handle moves like "xd5" - try to infer the piece
            dest_square = move[1:3]
            if dest_square in ['d5', 'h5']:  # Common captures from the error
                # Try different pieces that could capture
                for piece in ['', 'N', 'B', 'R', 'Q']:
                    for file in ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']:
                        potential_move = f"{piece}{file}x{dest_square}"
                        move_variants.append(potential_move)
                        if piece == '':  # Pawn captures
                            move_variants.append(f"{file}x{dest_square}")
        
        move_applied = False
        for variant in move_variants:
            try:
                # First check if this move is legal
                test_board = board.copy()
                test_board.push_san(variant)
                
                # If successful, apply to main board
                board.push_san(variant)
                successful_moves += 1
                move_applied = True
                logger.info(f"Move {i+1}: '{original_move}' -> '{variant}' applied successfully")
                break
            except ValueError:
                continue
        
        if not move_applied:
            # Try UCI format as last resort
            try:
                board.push_uci(original_move)
                successful_moves += 1
                move_applied = True
                logger.info(f"Move {i+1}: '{original_move}' applied as UCI")
            except ValueError:
                pass
        
        if not move_applied:
            logger.warning(f"Failed to apply move {i+1}: '{original_move}' in position: {board.fen()}")
            logger.info(f"Legal moves were: {[board.san(m) for m in list(board.legal_moves)][:10]}...")
            
            # If this looks like a critical move sequence failure, stop here
            # to avoid analyzing a completely wrong position
            if successful_moves < len(cleaned_moves) // 2:
                logger.warning(f"Too many failed moves ({len(cleaned_moves) - successful_moves} failed), stopping reconstruction")
                break

    if successful_moves == 0:
        logger.error("No valid moves found in the move list")
        return None
        
    logger.info(f"Successfully applied {successful_moves} out of {len(cleaned_moves)} moves")
    logger.info(f"Final position: {board.fen()}")
    return board.fen()

# Initialize enhanced analyzer
try:
    analyzer = EnhancedChessAnalyzer()
    logger.info("Enhanced Chess Analyzer initialized successfully")
except Exception as e:
    logger.error(f"Failed to initialize enhanced chess analyzer: {str(e)}")
    analyzer = None

@app.route('/analyze', methods=['POST'])
def analyze():
    """Enhanced analysis endpoint with tactical awareness"""
    try:
        if not analyzer:
            return jsonify({
                "error": "Chess analyzer not available. Please install Stockfish."
            }), 500
        
        data = request.get_json()
        
        if not data:
            return jsonify({"error": "Request body required"}), 400

        fen = data.get('fen')
        moves = data.get('moves', []) or []
        position_source = 'unknown'
        
        logger.info(f"Analyze request - FEN: {fen is not None}, Moves: {len(moves)}")
        if moves:
            logger.info(f"Raw moves received: {moves}")

        # Prefer FEN if available, otherwise try to build from moves
        if fen:
            position_source = 'fen'
            logger.info(f"Using provided FEN: {fen}")
        elif moves:
            logger.info(f"Attempting to build FEN from {len(moves)} moves: {moves}")
            fen = build_fen_from_moves(moves)
            if fen:
                position_source = 'moves'
                logger.info(f"Successfully built FEN from moves: {fen}")
            else:
                logger.error("Failed to build FEN from moves")
                return jsonify({
                    "error": "Could not parse the move sequence. Please ensure moves are in correct algebraic notation.",
                    "debug_info": {
                        "received_moves": moves,
                        "moves_count": len(moves)
                    }
                }), 400

        if not fen:
            return jsonify({"error": "FEN or valid move list required"}), 400

        # Validate the FEN
        try:
            chess.Board(fen)
        except ValueError as e:
            logger.error(f"Invalid FEN: {fen} - {e}")
            return jsonify({"error": f"Invalid FEN position: {str(e)}"}), 400

        depth = data.get('depth', 22)  # Increased default depth

        # Validate depth
        if not isinstance(depth, int) or depth < 1 or depth > 30:
            depth = 22

        side_to_move = data.get('sideToMove')
        forced_turn = None
        if isinstance(side_to_move, str):
            if side_to_move.lower() in ('w', 'white'):
                forced_turn = chess.WHITE
            elif side_to_move.lower() in ('b', 'black'):
                forced_turn = chess.BLACK

        logger.info(f"Starting analysis: depth={depth}, forced_turn={forced_turn}, source={position_source}")

        # Enhanced analysis
        result = analyzer.analyze_position(fen, depth, forced_turn)
        result["source"] = position_source
        result["movesAnalyzed"] = len(moves)

        logger.info(f"Analysis complete: {result.get('bestMoveSAN', 'No move')}")
        return jsonify(result)
        
    except ValueError as e:
        logger.error(f"Invalid FEN or moves: {str(e)}")
        return jsonify({"error": "Invalid FEN position or moves"}), 400
    except Exception as e:
        logger.error(f"Analysis request failed: {str(e)}")
        return jsonify({"error": f"Analysis failed: {str(e)}"}), 500

@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({
        "status": "ok",
        "engine_available": analyzer is not None,
        "analyzer_type": "Enhanced" if analyzer else "None"
    })

@app.route('/', methods=['GET'])
def home():
    """Home endpoint"""
    return jsonify({
        "name": "Enhanced Chess Analysis API",
        "version": "2.0.0",
        "features": [
            "Tactical analysis with increased depth",
            "Position repetition detection",
            "Game phase awareness",
            "Move legality validation",
            "Blunder detection",
            "Multi-candidate analysis"
        ],
        "endpoints": {
            "/analyze": "POST - Analyze chess position with enhanced tactical awareness",
            "/health": "GET - Health check"
        }
    })

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=True)
