// Chess.com Analysis Content Script
console.log('Chess Analysis Extension: Content script loaded');

let analysisPanel = null;
let isAnalysisEnabled = true;
let analysisDepth = 15;
let backendUrl = 'http://localhost:5000';
let debounceTimer = null;
let lastPositionKey = '';
let lastAnalyzedFen = '';
let playerColor = null; // 'white' or 'black' - detect which side the user is playing

// Guards to prevent request loops and reduce noise
let requestInFlight = false;
let lastAnalyzedKey = '';
let lastRequestAt = 0;
let pendingRequestKey = '';
let currentObservedKey = '';
const MIN_REQUEST_INTERVAL_MS = 2000; // throttle backend calls

const PIECE_ICON_MAP = {
    '♔': 'K',
    '♕': 'Q',
    '♖': 'R',
    '♗': 'B',
    '♘': 'N',
    '♙': '',
    '♚': 'K',
    '♛': 'Q',
    '♜': 'R',
    '♝': 'B',
    '♞': 'N',
    '♟': ''
};

let chessJsReady = typeof window.Chess === 'function';
let chessJsLoadingPromise = null;

function ensureChessJsLoaded() {
    if (chessJsReady) {
        return Promise.resolve();
    }

    if (chessJsLoadingPromise) {
        return chessJsLoadingPromise;
    }

    chessJsLoadingPromise = new Promise((resolve, reject) => {
        try {
            const existing = document.querySelector('script[data-chess-js="true"]');
            if (existing) {
                existing.addEventListener('load', () => {
                    chessJsReady = typeof window.Chess === 'function';
                    if (chessJsReady) {
                        console.log('chess.js already loaded');
                        resolve();
                    } else {
                        reject(new Error('chess.js script present but Chess not available'));
                    }
                });
                existing.addEventListener('error', (err) => {
                    console.error('Failed to load chess.js (existing script)', err);
                    reject(err);
                });
                return;
            }

            const script = document.createElement('script');
            script.src = chrome.runtime.getURL('chess.js');
            script.dataset.chessJs = 'true';
            script.onload = () => {
                chessJsReady = typeof window.Chess === 'function';
                if (chessJsReady) {
                    console.log('chess.js loaded successfully');
                    resolve();
                } else {
                    reject(new Error('chess.js loaded but Chess not defined'));
                }
            };
            script.onerror = (err) => {
                console.error('Failed to load chess.js', err);
                reject(err);
            };
            document.documentElement.appendChild(script);
        } catch (error) {
            console.error('Error injecting chess.js', error);
            reject(error);
        }
    });

    return chessJsLoadingPromise;
}

ensureChessJsLoaded().catch((err) => {
    console.warn('Continuing without chess.js - move reconstruction will be limited', err);
});

function initializeExtension() {
    console.log('Chess Analysis Extension: Initializing...');
    loadSettings();
    detectPlayerColor();
    createAnalysisPanel();
    installDebugHelper();
    ensureChessJsLoaded()
        .catch((err) => {
            console.warn('Proceeding without chess.js while waiting for load', err);
        })
        .finally(() => {
            startBoardMonitoring();
        });
}

function installDebugHelper() {
    try {
        window.__chessAnalysisDebug = () => {
            const boards = Array.from(document.querySelectorAll('chess-board, wc-chess-board, cg-board'));
            const pieces = Array.from(document.querySelectorAll('.piece, [data-piece]')).slice(0, 6);
            const extraction = extractMovesAndFen();
            const report = {
                url: location.href,
                boards: boards.map((b) => ({
                    tag: b.tagName.toLowerCase(),
                    attrs: Array.from(b.attributes || []).map((a) => `${a.name}=${a.value}`),
                    hasShadow: Boolean(b.shadowRoot)
                })),
                pieceSample: pieces.map((p) => ({
                    tag: p.tagName.toLowerCase(),
                    cls: p.className,
                    dataset: Object.assign({}, p.dataset || {})
                })),
                totalPieceElements: document.querySelectorAll('.piece, [data-piece]').length,
                extraction: {
                    movesCount: extraction.moves?.length || 0,
                    hasFen: Boolean(extraction.fen),
                    fen: extraction.fen,
                    sampleMoves: (extraction.moves || []).slice(0, 6)
                },
                playerColor
            };
            console.log('[chess-analysis debug]', report);
            return report;
        };
    } catch (e) {
        console.warn('Failed to install debug helper', e);
    }
}

function detectPlayerColor() {
    try {
        const updateColor = (color) => {
            const normalized = color === 'b' ? 'black' : color === 'w' ? 'white' : color;
            const finalColor = normalized === 'black' ? 'black' : 'white';
            if (playerColor !== finalColor) {
                playerColor = finalColor;
                console.log('Detected player color:', finalColor);
            }
        };

        const boardSelectors = [
            'chess-board',
            '.board-layout-main chess-board',
            '#board-layout-chessboard chess-board',
            'cg-board'
        ];

        for (const selector of boardSelectors) {
            const boardEl = document.querySelector(selector);
            if (!boardEl) continue;

            const orientationAttr = (boardEl.getAttribute('orientation') || boardEl.dataset?.orientation || '').toLowerCase();
            if (orientationAttr === 'white' || orientationAttr === 'w') {
                updateColor('white');
                return;
            }
            if (orientationAttr === 'black' || orientationAttr === 'b') {
                updateColor('black');
                return;
            }

            if (boardEl.classList.contains('flipped') || boardEl.hasAttribute('flipped')) {
                updateColor('black');
                return;
            }
        }

        const bottomWrapper = document.querySelector('[data-player-btm]');
        if (bottomWrapper) {
            const attr = (bottomWrapper.getAttribute('data-player-btm') || '').toLowerCase();
            if (attr === 'white' || attr === 'black') {
                updateColor(attr);
                return;
            }
        }

        const clockBottom = document.querySelector('.clock-player-bottom[data-player-color]');
        if (clockBottom) {
            const attr = (clockBottom.getAttribute('data-player-color') || '').toLowerCase();
            if (attr === 'white' || attr === 'black') {
                updateColor(attr);
                return;
            }
        }

        updateColor(playerColor || 'white');
    } catch (e) {
        console.log('Error detecting player color:', e);
        if (!playerColor) {
            playerColor = 'white';
        }
    }
}

function loadSettings() {
    chrome.storage.sync.get(['chessAnalysisSettings'], (result) => {
        if (result.chessAnalysisSettings) {
            const settings = result.chessAnalysisSettings;
            isAnalysisEnabled = settings.enabled !== false;
            analysisDepth = settings.depth || 15;
            backendUrl = settings.backendUrl || 'http://localhost:5000';
            updateDepthDisplay();
        }
        console.log('Settings loaded:', { isAnalysisEnabled, analysisDepth, backendUrl });
        if (!isAnalysisEnabled && analysisPanel) {
            analysisPanel.style.display = 'none';
        }
    });
}

const PANEL_ICONS = {
    logo: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 21h12"/><path d="M8 21v-7"/><path d="M16 21v-7"/><path d="M5 14h14"/><path d="M6 10h12"/><path d="M5 4v4h2V5h2v3h2V5h2v3h2V5h2v3h2V4Z"/></svg>`,
    target: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/></svg>`,
    scale: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18"/><path d="M4 7h16"/><path d="M4 7l-2 6a4 4 0 0 0 8 0L8 7"/><path d="M20 7l-2 6a4 4 0 0 0 8 0L24 7" transform="translate(-4 0)"/></svg>`,
    layers: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 3 8l9 5 9-5Z"/><path d="M3 13l9 5 9-5"/><path d="M3 17l9 5 9-5"/></svg>`,
    check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2 20h20Z"/><path d="M12 10v5"/><circle cx="12" cy="18" r="0.6" fill="currentColor"/></svg>`,
    crown: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 18h18"/><path d="M4 8l4 5 4-9 4 9 4-5v10H4Z"/></svg>`,
    castle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21h16"/><path d="M6 21v-8M18 21v-8"/><path d="M4 13h16"/><path d="M5 4v4h2V5h2v3h2V5h2v3h2V5h2v3h2V4Z"/></svg>`
};

function createAnalysisPanel() {
    if (analysisPanel) {
        analysisPanel.remove();
    }

    analysisPanel = document.createElement('div');
    analysisPanel.id = 'chess-analysis-panel';
    analysisPanel.className = 'cae-panel';
    analysisPanel.style.display = 'none';

    analysisPanel.innerHTML = `
        <div class="cae-aurora" aria-hidden="true"></div>
        <div class="cae-header">
            <div class="cae-brand">
                <span class="cae-brand-mark">${PANEL_ICONS.logo}</span>
                <span class="cae-brand-label">
                    <span class="cae-brand-title">Chess Analysis</span>
                    <span class="cae-brand-sub">Engine overlay</span>
                </span>
            </div>
            <div class="cae-status" id="analysis-status-pill">
                <span class="cae-status-dot"></span>
                <span class="cae-status-text" id="analysis-status">Standby</span>
            </div>
        </div>

        <div class="cae-section cae-section-move">
            <div class="cae-section-head">
                <span class="cae-section-icon">${PANEL_ICONS.target}</span>
                <span class="cae-section-title">Suggested move</span>
            </div>
            <div class="cae-move" id="move-text">—</div>
            <div class="cae-move-desc" id="move-description">Waiting for a position.</div>
        </div>

        <div class="cae-section cae-section-eval">
            <div class="cae-section-head">
                <span class="cae-section-icon">${PANEL_ICONS.scale}</span>
                <span class="cae-section-title">Evaluation</span>
                <span class="cae-eval-value" id="eval-text">—</span>
            </div>
            <div class="cae-eval-bar" aria-hidden="true">
                <div class="cae-eval-fill" id="eval-fill" style="width:50%"></div>
                <div class="cae-eval-pivot"></div>
            </div>
            <div class="cae-eval-legend">
                <span>Black</span>
                <span>Equal</span>
                <span>White</span>
            </div>
        </div>

        <div class="cae-footer">
            <span class="cae-footer-icon">${PANEL_ICONS.layers}</span>
            <span class="cae-footer-text">Depth <span id="depth-value">${analysisDepth}</span></span>
        </div>
    `;

    document.body.appendChild(analysisPanel);
    console.log('Analysis panel created');

    if (isAnalysisEnabled) {
        analysisPanel.style.display = 'block';
    }
}

function setPanelStatus(state) {
    if (!analysisPanel) return;
    const pill = analysisPanel.querySelector('#analysis-status-pill');
    if (!pill) return;
    pill.dataset.state = state || 'idle';
}

function parseEvaluation(evalStr) {
    if (evalStr == null || evalStr === '-' || evalStr === '') {
        return { whitePct: 50, label: '—', state: 'idle' };
    }
    const trimmed = String(evalStr).trim();
    const mateMatch = trimmed.match(/^(-)?M(-?\d+)$/i);
    if (mateMatch) {
        const negative = Boolean(mateMatch[1]) || parseInt(mateMatch[2], 10) < 0;
        return {
            whitePct: negative ? 2 : 98,
            label: `M${Math.abs(parseInt(mateMatch[2], 10))}`,
            state: negative ? 'black' : 'white'
        };
    }
    const pawns = parseFloat(trimmed);
    if (Number.isNaN(pawns)) {
        return { whitePct: 50, label: trimmed, state: 'idle' };
    }
    const ratio = Math.tanh(pawns / 3);
    const pct = Math.max(2, Math.min(98, 50 + 50 * ratio));
    const sign = pawns > 0 ? '+' : '';
    return {
        whitePct: pct,
        label: `${sign}${pawns.toFixed(1)}`,
        state: pawns > 0.2 ? 'white' : pawns < -0.2 ? 'black' : 'equal'
    };
}

function updateEvalBar(evalStr) {
    if (!analysisPanel) return;
    const fill = analysisPanel.querySelector('#eval-fill');
    const label = analysisPanel.querySelector('#eval-text');
    const parsed = parseEvaluation(evalStr);
    if (fill) {
        fill.style.width = `${parsed.whitePct}%`;
        fill.dataset.state = parsed.state;
    }
    if (label) {
        label.textContent = parsed.label;
        label.dataset.state = parsed.state;
    }
}

function updateDepthDisplay() {
    if (!analysisPanel) return;
    const depthElement = analysisPanel.querySelector('#depth-value');
    if (depthElement) {
        depthElement.textContent = analysisDepth;
    }
}

function startBoardMonitoring() {
    console.log('Starting board monitoring...');

    // Observe the chess board container rather than whole document to reduce noise
    const boardTarget = document.querySelector('chess-board, .board-layout-main chess-board, #board-layout-chessboard') || document.body;

    const observer = new MutationObserver((mutations) => {
        let relevant = false;
        for (const mutation of mutations) {
            if (mutation.type === 'childList' || mutation.type === 'attributes') {
                relevant = true;
                break;
            }
        }
        if (relevant) {
            // Re-detect player color in case board was flipped or game changed
            detectPlayerColor();
            debouncedAnalyzePosition();
        }
    });

    observer.observe(boardTarget, {
        childList: true,
        subtree: true,
        attributes: true,
        // Only observe attributes that indicate real board state changes
        attributeFilter: ['data-fen', 'data-state', 'data-turn', 'flipped']
    });

    setInterval(() => {
        if (isAnalysisEnabled) {
            analyzeCurrentPosition();
        }
    }, 4000);

    console.log('Board monitoring started');
}

function debouncedAnalyzePosition() {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
        if (isAnalysisEnabled) {
            analyzeCurrentPosition();
        }
    }, 1200);
}

function analyzeCurrentPosition() {
    try {
        if (!playerColor) {
            detectPlayerColor();
        }

        const { moves, fen, positionKey } = extractMovesAndFen();

        if ((!moves || moves.length === 0) && !fen) {
            const pieceCount = document.querySelectorAll('.piece, [data-piece]').length;
            console.warn('[chess-analysis] No FEN and no moves extracted. piece-elements=' + pieceCount +
                '. Run window.__chessAnalysisDebug() in DevTools for a full dump.');
            updateAnalysisPanel('-', 'Could not read the board. Open DevTools and run window.__chessAnalysisDebug().', '-', 'Board not detected');
            return;
        }

        // Derive stable key (prefer FEN) for position-identity comparisons
        let stableKey;
        if (isLikelyFen(fen)) {
            stableKey = normalizeFenForKey(fen);
        } else {
            stableKey = positionKey || moves.join(' ');
        }
        
        if (!stableKey) {
            updateAnalysisPanel('-', 'Could not read board position', '-', 'Could not determine game state');
            return;
        }

        currentObservedKey = stableKey;

        console.log('=== POSITION ANALYSIS ===');
        console.log('Raw FEN:', fen);
        console.log('Moves count:', moves ? moves.length : 0);
        console.log('Position key:', stableKey);
        console.log('Last analyzed key:', lastAnalyzedKey);
        console.log('Pending request key:', pendingRequestKey);

        // Determine whose turn it is (prefer FEN side, then manual detection)
        let currentTurn;
        if (isLikelyFen(fen)) {
            currentTurn = sideToMoveFromFen(fen);
            console.log('Turn from FEN:', currentTurn);
        } else {
            currentTurn = determineSideToMove(moves.length);
            console.log('Turn from detection/moves:', currentTurn);
        }
        
        const userSide = playerColor === 'black' ? 'b' : 'w';
        const isUserTurn = currentTurn === userSide;

        console.log('Turn Analysis:');
        console.log('- Current Turn:', currentTurn);
        console.log('- User Side:', userSide);
        console.log('- Is User Turn:', isUserTurn);
        console.log('- Player Color:', playerColor);

        if (!isUserTurn) {
            console.log('Not user turn - showing waiting message');
            if (analysisPanel) {
                updateAnalysisPanel('-', 'Waiting for opponent move...', '-', 'Opponent to move');
                analysisPanel.style.display = isAnalysisEnabled ? 'block' : 'none';
            }
            pendingRequestKey = '';
            return;
        }

        if (analysisPanel && isAnalysisEnabled) {
            analysisPanel.style.display = 'block';
        }

        const now = Date.now();
        if (now - lastRequestAt < MIN_REQUEST_INTERVAL_MS) {
            console.log('Request throttled - too soon');
            return; // throttled
        }
        if (requestInFlight) {
            console.log('Request already in flight');
            return; // wait for current request to finish
        }
        if (stableKey === lastAnalyzedKey || stableKey === pendingRequestKey) {
            console.log('Position unchanged - skipping duplicate analysis');
            return;
        }

        console.log('Starting new analysis request with key:', stableKey);
        pendingRequestKey = stableKey;
        lastRequestAt = now;
        sendAnalysisRequest({ fen, moves, sideToMove: currentTurn, positionKey: stableKey });
    } catch (error) {
        console.error('Error analyzing position:', error);
        updateAnalysisPanel('Error', 'Analysis failed to parse position', '-', 'Failed to analyze position');
    }
}

function extractMovesAndFen() {
    let fen = null;
    let mostRecentFen = null;
    const rawMoveInfos = [];

    // PRIORITY 1: Try to grab FEN straight from board element first (most reliable)
    fen = getFenFromBoardElement();
    if (fen) {
        console.log('Found FEN from board element:', fen);
        console.log('Using FEN-only analysis for Chess.com reliability');
        return { moves: [], fen, positionKey: normalizeFenForKey(fen) };
    }

    // PRIORITY 1.5: Try Chess.com specific FEN extraction methods
    fen = extractChessComFen();
    if (fen) {
        console.log('Found FEN from Chess.com specific method:', fen);
        return { moves: [], fen, positionKey: normalizeFenForKey(fen) };
    }

    // PRIORITY 2: Build FEN from visible board pieces (shadow DOM aware)
    const boardInfoEarly = extractFenFromBoard(0);
    if (boardInfoEarly?.fen) {
        fen = boardInfoEarly.fen;
        console.log('Constructed FEN early from board pieces:', fen);
        return { moves: [], fen, positionKey: normalizeFenForKey(fen) };
    }

    console.log('No direct FEN found; attempting move list reconstruction...');

    const moveSelectors = [
        // Chess.com specific selectors (prioritized)
        'wc-simple-move-list .node',
        'wc-vertical-move-list .node',
        'wc-horizontal-move-list .move',
        '.moves-text .move',
        '.move-text-component .move-san',
        '.nodes .node-label',
        '.move-list-component .move-san',
        '.vertical-move-list .move-san',
        'chess-move .move-san',
        '[data-testid="pgn-move"] span',
        '[data-ply]',

        // Generic fallbacks
        '.move-san',
        '.node',
        '[data-cy="move"]',
        '.notations .move',
        '.vertical-move-list .move',
        '.move-list .move',
        '.move',
        'span[class*="move"]',
        'div[class*="move"]'
    ];

    for (const selector of moveSelectors) {
        const moveElements = document.querySelectorAll(selector);
        if (!moveElements.length) {
            continue;
        }

        console.log(`Selector "${selector}" found ${moveElements.length} elements`);

        moveElements.forEach((element, index) => {
            if (!element) {
                return;
            }

            const parentClass = element.parentElement?.className || '';
            if (parentClass.includes('variation') || parentClass.includes('analysis')) {
                return;
            }

            const rawText = (element.textContent || '').trim();
            const normalizedText = normalizeMoveText(rawText);
            const sanHint = extractSanHint(element);
            const uciHint = extractUciHint(element);
            const pieceHint = inferPieceHint(element, normalizedText);
            const ariaLabel = element.getAttribute('aria-label') || '';
            const candidateFen = element.getAttribute('data-fen') || element.dataset?.fen;

            if (isLikelyFen(candidateFen)) {
                mostRecentFen = candidateFen;
            }

            const datasetSnapshot = Object.assign({}, element.dataset || {});

            const isCaptureHint = Boolean(
                (normalizedText && normalizedText.includes('x')) ||
                (sanHint && sanHint.includes('x')) ||
                (ariaLabel && /capture|takes/i.test(ariaLabel))
            );

            rawMoveInfos.push({
                index: rawMoveInfos.length,
                selector,
                rawText,
                normalizedText,
                sanHint,
                uciHint,
                pieceHint,
                ariaLabel,
                dataset: datasetSnapshot,
                htmlSnippet: element.innerHTML?.slice(0, 200) || '',
                isCapture: isCaptureHint
            });
        });

        if (rawMoveInfos.length) {
            break;
        }
    }

    let reconstructionResult = null;
    if (rawMoveInfos.length) {
        reconstructionResult = reconstructMovesWithChess(rawMoveInfos);
    }

    let moves = reconstructionResult?.moves || [];

    // Heuristic: if we have move texts that are only bare pawn square advances (no piece letters, no captures)
    // for >60% of the list AND at least one invalid/failed item appeared, we discard moves and prefer board FEN.
    if (moves.length) {
        const barePawnRegex = /^[a-h][1-8]$/;
        const bareCount = moves.filter(m => barePawnRegex.test(m)).length;
        const ratio = bareCount / moves.length;
        if (ratio > 0.6 && reconstructionResult?.incomplete) {
            console.warn('High ratio of bare-square moves with incomplete reconstruction; discarding move list.');
            moves = [];
        }
    }

    if (!fen && reconstructionResult?.fen && !reconstructionResult.incomplete) {
        fen = reconstructionResult.fen;
    }

    if (reconstructionResult?.incomplete) {
        console.warn('Move reconstruction incomplete - preferring FEN fallback when available');
        if (fen) {
            moves = [];
        } else {
            const boardInfo = extractFenFromBoard(rawMoveInfos.length);
            if (boardInfo?.fen) {
                fen = boardInfo.fen;
                moves = [];
                console.log('Derived FEN from board after partial reconstruction:', fen);
            }
        }
    }

    if (!fen && mostRecentFen) {
        fen = mostRecentFen;
        console.log('Using most recent move-derived FEN:', fen);
        if (moves.length > 0 && rawMoveInfos.length >= moves.length + 3) {
            console.log('Move/FEN mismatch detected - falling back to FEN-only response');
            moves = [];
        }
    }

    if (!fen) {
        const fenElement = document.querySelector('[data-fen]');
        if (fenElement) {
            const value = fenElement.getAttribute('data-fen');
            if (isLikelyFen(value)) {
                fen = value;
                console.log('Using fallback DOM FEN:', fen);
            }
        }
    }

    if (!fen) {
        const boardInfo = extractFenFromBoard(moves.length || rawMoveInfos.length);
        if (boardInfo) {
            fen = boardInfo.fen;
            console.log('Constructed FEN from board pieces:', fen);
        }
    }

    const positionKey = fen ? normalizeFenForKey(fen) : moves.join(' ');
    console.log('Final extraction result:', {
        movesCount: moves.length,
        hasFen: Boolean(fen),
        reconstructionUsed: Boolean(reconstructionResult?.usedChess),
        reconstructionComplete: reconstructionResult ? !reconstructionResult.incomplete : false,
        strategy: fen ? (moves.length === 0 ? 'FEN-only' : 'FEN+moves') : 'moves-only',
        positionKey: positionKey.substring(0, 50) + '...'
    });

    return { moves, fen, positionKey };
}

function normalizeMoveText(rawText) {
    if (!rawText) return '';

    let moveText = rawText.trim();
    
    // Handle piece icons - convert to standard notation
    moveText = moveText.replace(/[♔♕♖♗♘♙♚♛♜♝♞♟]/g, (icon) => PIECE_ICON_MAP[icon] ?? '');
    
    // Remove move numbers and dots
    moveText = moveText.replace(/^(\d+\.|\d+\s*\.{3})\s*/, '');
    
    // Remove extra whitespace
    moveText = moveText.replace(/\s+/g, '');

    // Remove parentheses around entire move
    moveText = moveText.replace(/^\(.*\)$/g, '');
    
    // Remove game results
    moveText = moveText.replace(/^1-0$|^0-1$|^1\/2-1\/2$/, '');

    // CHESS.COM SPECIFIC FIXES FOR MALFORMED NOTATION:
    
    // Fix malformed capture notation like "xb5" (missing capturing piece)
    if (moveText.match(/^x[a-h][1-8][+#]?$/)) {
        console.warn(`Malformed capture notation detected: "${moveText}" - trying to reconstruct`);
        
        // Try to reconstruct the capture by analyzing common Chess.com patterns
        const targetSquare = moveText.replace(/^x/, '').replace(/[+#]$/, '');
        const checkSuffix = moveText.match(/[+#]$/)?.[0] || '';
        
        // Common Chess.com capture patterns - try likely pieces
        const likelyCaptures = [
            `B${moveText}`,  // Bishop capture
            `N${moveText}`,  // Knight capture  
            `R${moveText}`,  // Rook capture
            `Q${moveText}`,  // Queen capture
            `c${moveText}`,  // c-pawn capture (most common)
            `d${moveText}`,  // d-pawn capture
            `e${moveText}`,  // e-pawn capture
            `f${moveText}`   // f-pawn capture
        ];
        
        console.log(`Trying reconstruction options for "${moveText}":`, likelyCaptures);
        
        // For now, skip malformed captures - let backend handle the position mismatch
        console.warn(`Cannot reliably reconstruct "${moveText}" - skipping`);
        return null; // Return null to signal this move should be skipped
    }
    
    // Fix notation like "b5+" that should probably be piece moves
    // If we have a square that's not a typical pawn move and has check/checkmate
    if (moveText.match(/^[a-h][1-8][+#]$/) && 
        !moveText.match(/^[a-h][28][+#]$/) && // Not pawn promotion ranks
        !moveText.match(/^[a-h][34567][+#]$/) && // Not typical central pawn moves
        moveText.match(/^[a-h][1-8][+#]$/)) {
        console.warn(`Suspicious move notation: "${moveText}" - might be missing piece, but keeping as-is`);
    }
    
    // If we have a bare square like "e2", "f3", etc. that's not a pawn move,
    // it might be missing piece notation. This is a common issue with Chess.com's DOM.
    if (moveText && /^[a-h][1-8]$/.test(moveText)) {
        // For squares that are not typical pawn moves (rank 1,8 or captures)
        if (!moveText.match(/^[a-h][28]$/) && !moveText.includes('x')) {
            console.warn(`Possible incomplete move notation: "${moveText}" - might be missing piece`);
        }
    }

    return moveText;
}

function extractSanHint(element) {
    if (!element) return null;
    const rawCandidates = [
        element.getAttribute('data-san'),
        element.dataset?.san,
        element.dataset?.notation,
        element.dataset?.moveSan,
        element.dataset?.pgn,
        element.getAttribute('data-pgn'),
        element.getAttribute('data-move'),
        element.getAttribute('move')
    ];

    for (const candidate of rawCandidates) {
        const value = candidate ? candidate.trim() : '';
        if (!value) continue;
        const normalized = normalizeMoveText(value);
        if (normalized && isValidMoveFormat(normalized)) {
            return normalized;
        }
    }

    const aria = element.getAttribute('aria-label');
    if (aria) {
        const inferred = normalizeMoveText(aria.replace(/captures/gi, 'x').replace(/takes/gi, 'x'));
        if (inferred && isValidMoveFormat(inferred)) {
            return inferred;
        }
    }

    return null;
}

function extractUciHint(element) {
    if (!element) return null;
    const rawCandidates = [
        element.getAttribute('data-uci'),
        element.dataset?.uci,
        element.dataset?.uciMove,
        element.dataset?.moveUci,
        element.getAttribute('data-move-uci'),
        element.getAttribute('uci'),
        element.dataset?.plyUci
    ];

    for (const candidate of rawCandidates) {
        const value = candidate ? candidate.trim().toLowerCase() : '';
        if (!value) continue;
        if (/^[a-h][1-8][a-h][1-8][nbrq]?$/.test(value)) {
            return value;
        }
    }
    return null;
}

function inferPieceHint(element, normalizedMove) {
    if (normalizedMove && /^[KQRBN]/.test(normalizedMove)) {
        return normalizedMove[0];
    }

    const examineStrings = [];

    if (element) {
        examineStrings.push(element.className || '');
        examineStrings.push(element.getAttribute('aria-label') || '');
        examineStrings.push(element.innerHTML || '');

        const datasetValues = Object.values(element.dataset || {});
        datasetValues.forEach((value) => examineStrings.push(value));

        let parent = element.parentElement;
        for (let depth = 0; depth < 2 && parent; depth += 1) {
            examineStrings.push(parent.className || '');
            const parentDatasetValues = Object.values(parent.dataset || {});
            parentDatasetValues.forEach((value) => examineStrings.push(value));
            parent = parent.parentElement;
        }
    }

    for (const value of examineStrings) {
        const piece = detectPieceInString(value);
        if (piece !== undefined) {
            return piece;
        }
    }

    return null;
}

function detectPieceInString(value) {
    if (!value) return undefined;
    const lower = value.toLowerCase();
    if (lower.includes('figurine') && lower.includes('king')) return 'K';
    if (lower.includes('figurine') && lower.includes('queen')) return 'Q';
    if (lower.includes('figurine') && lower.includes('rook')) return 'R';
    if (lower.includes('figurine') && lower.includes('bishop')) return 'B';
    if (lower.includes('figurine') && (lower.includes('knight') || lower.includes('horse'))) return 'N';
    if (lower.includes('figurine') && lower.includes('pawn')) return '';

    if (lower.includes('king')) return 'K';
    if (lower.includes('queen')) return 'Q';
    if (lower.includes('rook')) return 'R';
    if (lower.includes('bishop')) return 'B';
    if (lower.includes('knight') || lower.includes('horse')) return 'N';
    if (lower.includes('pawn')) return '';

    if (lower.trim() === 'k') return 'K';
    if (lower.trim() === 'q') return 'Q';
    if (lower.trim() === 'r') return 'R';
    if (lower.trim() === 'b') return 'B';
    if (lower.trim() === 'n') return 'N';
    if (lower.trim() === 'p') return '';

    return undefined;
}

function reconstructMovesWithChess(moveInfos) {
    if (!moveInfos || moveInfos.length === 0) {
        return { moves: [], fen: null, usedChess: false, incomplete: false };
    }

    if (typeof window.Chess !== 'function') {
        console.warn('chess.js not available - unable to reconstruct SAN moves');
        const fallbackMoves = moveInfos
            .map((info) => info.sanHint || info.normalizedText)
            .filter(Boolean);
        return { moves: fallbackMoves, fen: null, usedChess: false, incomplete: true };
    }

    const chess = new window.Chess();
    const resolvedMoves = [];
    let incomplete = false;

    for (const info of moveInfos) {
        const resolvedSan = resolveMoveWithChess(chess, info);
        if (!resolvedSan) {
            console.warn('Failed to resolve move - stopping reconstruction', info);
            incomplete = true;
            break;
        }
        resolvedMoves.push(resolvedSan);
    }

    const finalFen = chess.fen();
    return {
        moves: resolvedMoves,
        fen: finalFen,
        usedChess: true,
        incomplete
    };
}

function resolveMoveWithChess(chess, info) {
    const attempted = new Set();

    const suffix = (info.normalizedText || '').match(/[+#]+$/)?.[0] || '';
    const normalizedBase = (info.normalizedText || '').replace(/[+#?!]/g, '');
    const targetSquareMatch = normalizedBase.match(/([a-h][1-8])$/);
    const targetSquare = targetSquareMatch ? targetSquareMatch[1] : null;
    const captureRequested = Boolean(info.isCapture || normalizedBase.includes('x'));
    const promotionMatch = normalizedBase.match(/=([QRBN])$/i);
    const promotionHint = promotionMatch ? promotionMatch[1].toLowerCase() : null;

    const trySanCandidate = (candidate) => {
        if (!candidate || attempted.has(candidate)) {
            return null;
        }
        attempted.add(candidate);
        try {
            const test = chess.move(candidate, { sloppy: true });
            if (test) {
                chess.undo();
                const applied = chess.move(candidate, { sloppy: true });
                return applied ? applied.san : candidate;
            }
        } catch (e) {
            // ignore invalid attempts
        }
        return null;
    };

    const tryUciCandidate = (uci) => {
        if (!uci || attempted.has(uci)) {
            return null;
        }
        attempted.add(uci);
        if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) {
            return null;
        }
        const moveObj = {
            from: uci.slice(0, 2),
            to: uci.slice(2, 4)
        };
        if (uci.length === 5) {
            moveObj.promotion = uci[4];
        }
        const test = chess.move(moveObj);
        if (test) {
            chess.undo();
            const applied = chess.move(moveObj);
            return applied ? applied.san : null;
        }
        return null;
    };

    const resolveFromLegalMoves = () => {
        const legalMoves = chess.moves({ verbose: true });
        if (!legalMoves.length) {
            return null;
        }

        const normalizedSans = legalMoves.filter((m) => normalizeSan(m.san) === normalizedBase);
        if (normalizedSans.length === 1) {
            const selected = normalizedSans[0];
            const applied = chess.move({ from: selected.from, to: selected.to, promotion: selected.promotion });
            return applied ? applied.san : null;
        }

        if (targetSquare) {
            let candidates = legalMoves.filter((m) => m.to === targetSquare);

            if (captureRequested) {
                candidates = candidates.filter((m) => m.san.includes('x') || m.flags.includes('c') || m.flags.includes('e'));
            }

            if (promotionHint) {
                candidates = candidates.filter((m) => (m.promotion || '').toLowerCase() === promotionHint);
            }

            if (info.pieceHint !== undefined && info.pieceHint !== null) {
                const desiredPiece = info.pieceHint === '' ? 'p' : info.pieceHint.toLowerCase();
                const pieceFiltered = candidates.filter((m) => m.piece === desiredPiece);
                if (pieceFiltered.length) {
                    candidates = pieceFiltered;
                }
            }

            if (candidates.length === 1) {
                const selected = candidates[0];
                const applied = chess.move({ from: selected.from, to: selected.to, promotion: selected.promotion });
                return applied ? applied.san : null;
            }

            if (candidates.length > 1) {
                // Attempt disambiguation by from-file/from-rank hints in normalized text (e.g., Nbd7)
                const fileHintMatch = normalizedBase.match(/^[KQRBN]?([a-h])[^a-h]*[1-8]?x?[a-h][1-8]/);
                const rankHintMatch = normalizedBase.match(/^[KQRBN]?[a-h]?([1-8])x?[a-h][1-8]/);

                if (fileHintMatch) {
                    const fileHint = fileHintMatch[1];
                    const filtered = candidates.filter((m) => m.from[0] === fileHint);
                    if (filtered.length) {
                        candidates = filtered;
                    }
                }

                if (rankHintMatch) {
                    const rankHint = rankHintMatch[1];
                    const filtered = candidates.filter((m) => m.from[1] === rankHint);
                    if (filtered.length) {
                        candidates = filtered;
                    }
                }

                if (candidates.length === 1) {
                    const selected = candidates[0];
                    const applied = chess.move({ from: selected.from, to: selected.to, promotion: selected.promotion });
                    return applied ? applied.san : null;
                }

                if (candidates.length > 1) {
                    console.warn('Ambiguous move candidates, selecting first', candidates.map((c) => c.san));
                    const selected = candidates[0];
                    const applied = chess.move({ from: selected.from, to: selected.to, promotion: selected.promotion });
                    return applied ? applied.san : null;
                }
            }
        }

        return null;
    };

    // Try SAN hints first
    if (info.sanHint) {
        const resolved = trySanCandidate(info.sanHint);
        if (resolved) return resolved;
    }

    if (info.normalizedText) {
        const resolved = trySanCandidate(info.normalizedText);
        if (resolved) return resolved;
    }

    if (info.pieceHint && targetSquare && /^[a-h][1-8]$/.test(targetSquare)) {
        const candidate = `${info.pieceHint}${targetSquare}${suffix}`;
        const resolved = trySanCandidate(candidate);
        if (resolved) return resolved;
        if (captureRequested) {
            const captureCandidate = `${info.pieceHint}x${targetSquare}${suffix}`;
            const captureResolved = trySanCandidate(captureCandidate);
            if (captureResolved) return captureResolved;
        }
    }

    if (captureRequested && targetSquare && !info.pieceHint) {
        const capturePieces = ['B', 'N', 'R', 'Q'];
        for (const piece of capturePieces) {
            const candidate = `${piece}x${targetSquare}${suffix}`;
            const resolved = trySanCandidate(candidate);
            if (resolved) return resolved;
        }
    }

    if (info.uciHint) {
        const resolved = tryUciCandidate(info.uciHint);
        if (resolved) return resolved;
    }

    const legalResolved = resolveFromLegalMoves();
    if (legalResolved) {
        return legalResolved;
    }

    return null;
}

function normalizeSan(san) {
    if (!san) return '';
    return san.replace(/[+#?!]/g, '');
}

function isValidMoveFormat(move) {
    if (!move) return false;
    const sanPattern = /^(O-O(-O)?|[NBKRQ]?[a-h]?[1-8]?x?[a-h][1-8](=[NBRQ])?[+#]?|[a-h]x?[a-h][1-8](=[NBRQ])?[+#]?|[a-h][1-8][a-h][1-8][nbrq]?)$/i;
    // Reject lone piece letters or bare squares that could be ambiguous mid-game unless they are legal pawn advances.
    if (/^[KQRBN]$/.test(move)) return false;
    if (/^[a-h][1-8]$/.test(move)) {
        // Allow only if rank represents plausible initial or advancing pawn squares (exclude rank 1 for white / rank 8 for black midgame)
        const rank = parseInt(move[1], 10);
        if (rank === 1 || rank === 8) return false;
    }
    return sanPattern.test(move);
}

function describeMoveInEnglish(move, moveSide = 'w', userColorValue = playerColor) {
    if (!move || move === '-' || move === 'No move' || move === 'Error') {
        return 'Waiting for position.';
    }

    const pieceNames = {
        'K': 'King',
        'Q': 'Queen',
        'R': 'Rook',
        'B': 'Bishop',
        'N': 'Knight'
    };

    if (move === 'O-O' || move === '0-0') {
        return 'Castle kingside.';
    }
    if (move === 'O-O-O' || move === '0-0-0') {
        return 'Castle queenside.';
    }

    const userSide = userColorValue === 'black' ? 'b' : 'w';
    const isUserMove = moveSide === userSide;
    let pieceType = 'Pawn';
    const isCapture = move.includes('x');
    const isCheck = move.includes('+');
    const isCheckmate = move.includes('#');

    const firstChar = move[0];
    if (pieceNames[firstChar]) {
        pieceType = pieceNames[firstChar];
    }

    let sourceHint = '';
    const sourceMatch = move.match(/^[KQRBN]([a-h]|[1-8])/);
    if (sourceMatch) {
        const src = sourceMatch[1];
        sourceHint = src >= '1' && src <= '8' ? ` from rank ${src}` : ` from the ${src}-file`;
    }

    const squareMatch = move.match(/([a-h][1-8])/);
    const destination = squareMatch ? squareMatch[0] : '';
    const colNames = {
        'a': 'A', 'b': 'B', 'c': 'C', 'd': 'D',
        'e': 'E', 'f': 'F', 'g': 'G', 'h': 'H'
    };

    let description = '';
    if (destination) {
        const col = destination[0];
        const row = destination[1];
        const sqLabel = `${colNames[col] || col.toUpperCase()}${row}`;
        const prefix = isUserMove ? 'Move your' : 'Best reply: opponent plays';
        description = `${prefix} ${pieceType}${sourceHint} `;
        description += isCapture ? `to capture on ${sqLabel}` : `to ${sqLabel}`;
    }

    if (isCheckmate) {
        description += isUserMove ? '. Checkmate.' : '. This line mates you.';
    } else if (isCheck) {
        description += isUserMove ? '. Delivers check.' : '. Delivers check.';
    } else {
        description += '.';
    }

    return description;
}

async function sendAnalysisRequest(position) {
    let { fen, moves, sideToMove, positionKey } = position;

    if (!fen && (!moves || moves.length === 0)) {
        console.warn('No position data to send');
        pendingRequestKey = '';
        return;
    }

    console.log('=== ANALYSIS REQUEST START ===');
    console.log('Position Key:', positionKey);
    console.log('FEN:', fen);
    console.log('Side to Move:', sideToMove);
    console.log('Move Count:', moves ? moves.length : 0);
    console.log('Player Color:', playerColor);

    updateAnalysisPanel('...', 'Computing best move...', '-', 'Analyzing...');

    try {
        requestInFlight = true;
        // Final safety: if FEN is missing but moves contain any invalid SAN, try board FEN and drop moves.
        if (!fen && moves && moves.length) {
            const invalid = moves.some((m) => !isValidMoveFormat(m));
            if (invalid) {
                console.warn('Invalid moves detected right before send; switching to board-based FEN.');
                const boardInfo = extractFenFromBoard(moves.length);
                if (boardInfo?.fen) {
                    fen = boardInfo.fen;
                    moves = [];
                }
            }
        }

        const payload = {
            depth: analysisDepth
        };

        if (fen) {
            payload.fen = fen;
        }
        if (moves && moves.length > 0) {
            payload.moves = moves;
        }
        if (sideToMove) {
            payload.sideToMove = sideToMove;
        }

        console.log('Sending payload to backend:', payload);

        const response = await fetch(`${backendUrl}/analyze`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const result = await response.json();
        console.log('Backend response:', result);
        
        if (result.error) {
            throw new Error(result.error);
        }

        // Use SAN notation if available, otherwise use UCI notation
        const displayMove = result.bestMoveSAN || result.bestMove || 'No move';
        const effectiveSide = sideToMove || (playerColor === 'black' ? 'b' : 'w');

        console.log('Processing response:');
        console.log('- Display Move:', displayMove);
        console.log('- Effective Side:', effectiveSide);
        console.log('- Current Observed Key:', currentObservedKey);
        console.log('- Pending Request Key:', pendingRequestKey);

        const isResultCurrent = positionKey === currentObservedKey;

        if (!isResultCurrent) {
            console.log('Discarded stale result - position has changed');
            console.log('- Position Key:', positionKey);
            console.log('- Current Key:', currentObservedKey);
            lastRequestAt = 0;
            if (isAnalysisEnabled) {
                setTimeout(() => analyzeCurrentPosition(), 200);
            }
            return;
        }

        lastAnalyzedKey = positionKey;
        const moveDescription = describeMoveInEnglish(
            displayMove,
            effectiveSide,
            playerColor
        );

        console.log('✅ ACCEPTED RESULT');
        console.log('- Move Description:', moveDescription);
        console.log('- Evaluation:', result.evaluation);

        updateAnalysisPanel(
            displayMove,
            moveDescription,
            result.evaluation || '-',
            'Analysis complete'
        );

        if (fen) {
            lastAnalyzedFen = fen;
        }
        
        console.log('=== ANALYSIS REQUEST END ===\n');
    } catch (error) {
        console.error('❌ ANALYSIS FAILED:', error);
        lastAnalyzedKey = lastAnalyzedKey === positionKey ? '' : lastAnalyzedKey;
        lastRequestAt = 0;
        updateAnalysisPanel('Error', 'Connection failed', '-', 'Failed to connect to analysis engine');
    } finally {
        requestInFlight = false;
        pendingRequestKey = '';
    }
}

function updateAnalysisPanel(bestMove, description, evaluation, status, stateHint) {
    if (!analysisPanel) return;

    const statusElement = analysisPanel.querySelector('#analysis-status');
    const moveElement = analysisPanel.querySelector('#move-text');
    const descElement = analysisPanel.querySelector('#move-description');

    if (statusElement) statusElement.textContent = status;
    if (moveElement) moveElement.textContent = bestMove;
    if (descElement) descElement.textContent = description;

    updateEvalBar(evaluation);

    let pillState = stateHint;
    if (!pillState) {
        const s = (status || '').toLowerCase();
        if (s.includes('computing') || s.includes('analyz')) pillState = 'thinking';
        else if (s.includes('waiting') || s.includes('opponent') || s.includes('standby')) pillState = 'idle';
        else if (s.includes('fail') || s.includes('error')) pillState = 'error';
        else if (s.includes('complete')) pillState = 'ready';
        else pillState = 'idle';
    }
    setPanelStatus(pillState);

    if (isAnalysisEnabled) {
        analysisPanel.style.display = 'block';
    }
}

chrome.storage.onChanged.addListener((changes) => {
    if (changes.chessAnalysisSettings && changes.chessAnalysisSettings.newValue) {
        const settings = changes.chessAnalysisSettings.newValue;
        isAnalysisEnabled = settings.enabled !== false;
        analysisDepth = settings.depth || 15;
        backendUrl = settings.backendUrl || 'http://localhost:5000';
        updateDepthDisplay();

        console.log('Settings updated:', { isAnalysisEnabled, analysisDepth, backendUrl });

        if (!isAnalysisEnabled && analysisPanel) {
            analysisPanel.style.display = 'none';
        } else if (isAnalysisEnabled) {
            if (analysisPanel) {
                analysisPanel.style.display = 'block';
            }
            analyzeCurrentPosition();
        }
    }
});

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeExtension);
} else {
    setTimeout(initializeExtension, 1000);
}

function extractFenFromBoard(movesCount) {
    try {
        // Chess.com light-DOM markup looks like `<div class="piece wp square-45">` --
        // no data-* attributes; coordinates are in the class list.
        const pieceSelectors = [
            '[data-piece][data-square]',
            '.piece[data-square]',
            '[data-piece][square]',
            '[piece][square]',
            'chess-board .piece',
            'wc-chess-board .piece',
            '.piece'
        ];
        const pieceElements = [];

        const collectFromRoot = (root) => {
            if (!root || typeof root.querySelectorAll !== 'function') return;
            pieceSelectors.forEach((selector) => {
                try {
                    const nodes = root.querySelectorAll(selector);
                    if (nodes && nodes.length) {
                        nodes.forEach((node) => pieceElements.push(node));
                    }
                } catch (_) {}
            });
        };

        collectFromRoot(document);
        const boards = document.querySelectorAll('chess-board');
        boards.forEach((board) => {
            const shadow = board?.shadowRoot;
            if (shadow) {
                collectFromRoot(shadow);
            }
        });

        if (!pieceElements.length) {
            return null;
        }

        const squareToPiece = {};

        pieceElements.forEach((element) => {
            const datasetSquare = element.dataset?.square || element.dataset?.sq || element.dataset?.coord;
            const attrSquare = element.getAttribute('data-square') || element.getAttribute('square') || datasetSquare;
            const square = (attrSquare || extractSquareFromClasses(element.classList)).toLowerCase();
            const datasetPiece = element.dataset?.piece || element.dataset?.p || element.dataset?.type;
            const attrPiece = element.getAttribute('data-piece') || element.getAttribute('piece') || datasetPiece;
            const code = attrPiece || extractPieceCodeFromClasses(element.classList);
            const fenChar = mapPieceCodeToFen(code);
            if (square && fenChar) {
                squareToPiece[square] = fenChar;
            }
        });

        const ranks = [];
        for (let rank = 8; rank >= 1; rank--) {
            let empty = 0;
            let rankStr = '';
            for (let file = 0; file < 8; file++) {
                const fileLetter = String.fromCharCode(97 + file);
                const square = `${fileLetter}${rank}`;
                const piece = squareToPiece[square];
                if (piece) {
                    if (empty > 0) {
                        rankStr += empty;
                        empty = 0;
                    }
                    rankStr += piece;
                } else {
                    empty++;
                }
            }
            if (empty > 0) {
                rankStr += empty;
            }
            ranks.push(rankStr);
        }

        const sanity = validateFenSanity(squareToPiece);
        if (!sanity.ok) {
            console.warn('[chess-analysis] FEN from board failed sanity check:', sanity.reason);
            return null;
        }

        const boardPart = ranks.join('/');
        const effectiveMoves = (typeof movesCount === 'number' && movesCount > 0)
            ? movesCount
            : (countHalfMovesInDom() || 0);
        const sideToMove = determineSideToMove(effectiveMoves);
        const castling = inferCastlingRights(squareToPiece);
        const fullMove = Math.max(1, Math.floor(effectiveMoves / 2) + 1);

        const fen = `${boardPart} ${sideToMove} ${castling} - 0 ${fullMove}`;
        const key = `${boardPart}|${sideToMove}|${castling}|${fullMove}`;
        return { fen, key };
    } catch (error) {
        console.warn('Failed to extract board FEN:', error);
        return null;
    }
}

function extractSquareFromClasses(classList) {
    if (!classList) return '';
    for (const cls of classList) {
        if (cls.startsWith('square-')) {
            const suffix = cls.split('-')[1];
            if (!suffix) continue;
            // Chess.com modern markup: `square-45` means file=4 (d), rank=5.
            if (/^[1-8][1-8]$/.test(suffix)) {
                const file = String.fromCharCode(96 + parseInt(suffix[0], 10));
                const rank = parseInt(suffix[1], 10);
                return `${file}${rank}`;
            }
            if (/^[a-h][1-8]$/i.test(suffix)) {
                return suffix.toLowerCase();
            }
            // Rare: a single 0..63 index
            if (/^\d{1,2}$/.test(suffix)) {
                const index = parseInt(suffix, 10);
                if (!Number.isNaN(index) && index >= 0 && index <= 63) {
                    const file = String.fromCharCode(97 + (index % 8));
                    const rank = Math.floor(index / 8) + 1;
                    return `${file}${rank}`;
                }
            }
        }
        if (cls.startsWith('sq-')) {
            const suffix = cls.split('-')[1];
            if (suffix && /^[a-h][1-8]$/i.test(suffix)) {
                return suffix.toLowerCase();
            }
        }
        if (/^[a-h][1-8]$/.test(cls)) {
            return cls.toLowerCase();
        }
    }
    return '';
}

function extractPieceCodeFromClasses(classList) {
    if (!classList) return '';
    for (const cls of classList) {
        if (/^[wb][prnbkq]$/.test(cls)) {
            return cls;
        }
    }
    return '';
}

function mapPieceCodeToFen(code) {
    if (!code) return '';
    const lower = code.toLowerCase();
    const normalized = lower
        .replace(/[^a-z]/g, '')
        .replace('white', 'w')
        .replace('black', 'b')
        .replace('pawn', 'p')
        .replace('knight', 'n')
        .replace('bishop', 'b')
        .replace('rook', 'r')
        .replace('queen', 'q')
        .replace('king', 'k');

    const map = {
        'wp': 'P', 'wn': 'N', 'wb': 'B', 'wr': 'R', 'wq': 'Q', 'wk': 'K',
        'bp': 'p', 'bn': 'n', 'bb': 'b', 'br': 'r', 'bq': 'q', 'bk': 'k'
    };

    if (map[lower]) {
        return map[lower];
    }
    if (map[normalized]) {
        return map[normalized];
    }
    if (lower.length === 2 && map[lower[0] + lower[1]]) {
        return map[lower[0] + lower[1]];
    }
    return '';
}

function countHalfMovesInDom() {
    const nodeSelectors = [
        'wc-simple-move-list .node',
        'wc-vertical-move-list .node',
        'wc-horizontal-move-list .move',
        '.vertical-move-list .move',
        '.moves-text .move',
        '.move-list-component .move-san',
        '[data-ply]'
    ];
    for (const sel of nodeSelectors) {
        let nodes;
        try {
            nodes = document.querySelectorAll(sel);
        } catch (_) {
            continue;
        }
        if (!nodes || nodes.length === 0) continue;
        const main = Array.from(nodes).filter((n) => {
            const parentCls = n.parentElement?.className || '';
            return !parentCls.includes('variation') && !parentCls.includes('analysis');
        });
        if (main.length > 0) return main.length;
    }
    return null;
}

function inferCastlingRights(squareToPiece) {
    let rights = '';
    if (squareToPiece.e1 === 'K') {
        if (squareToPiece.h1 === 'R') rights += 'K';
        if (squareToPiece.a1 === 'R') rights += 'Q';
    }
    if (squareToPiece.e8 === 'k') {
        if (squareToPiece.h8 === 'r') rights += 'k';
        if (squareToPiece.a8 === 'r') rights += 'q';
    }
    return rights || '-';
}

function validateFenSanity(squareToPiece) {
    const values = Object.values(squareToPiece);
    const whiteKings = values.filter((p) => p === 'K').length;
    const blackKings = values.filter((p) => p === 'k').length;
    if (whiteKings !== 1 || blackKings !== 1) {
        return { ok: false, reason: `king counts white=${whiteKings} black=${blackKings}` };
    }
    const totalPieces = values.length;
    if (totalPieces < 2 || totalPieces > 32) {
        return { ok: false, reason: `piece count ${totalPieces}` };
    }
    for (const [sq, p] of Object.entries(squareToPiece)) {
        if (p.toLowerCase() !== 'p') continue;
        const rank = sq[1];
        if (rank === '1' || rank === '8') {
            return { ok: false, reason: `pawn on back rank at ${sq}` };
        }
    }
    return { ok: true };
}

function determineSideToMove(movesCount) {
    try {
        // Method 1: Check board element turn attributes (most reliable)
        const boardEl = document.querySelector('chess-board, .board-layout-main chess-board');
        if (boardEl) {
            const turnAttr = boardEl.getAttribute('data-turn') || boardEl.dataset?.turn;
            if (turnAttr === 'white' || turnAttr === 'w') {
                console.log('Turn detected from board attribute: white');
                return 'w';
            }
            if (turnAttr === 'black' || turnAttr === 'b') {
                console.log('Turn detected from board attribute: black');
                return 'b';
            }
            
            const stateAttr = boardEl.getAttribute('data-state');
            if (stateAttr) {
                try {
                    const state = JSON.parse(stateAttr);
                    if (state?.turn) {
                        const turn = state.turn === 'white' ? 'w' : state.turn === 'black' ? 'b' : null;
                        if (turn) {
                            console.log('Turn detected from board state:', turn);
                            return turn;
                        }
                    }
                } catch (_) {}
            }
        }

        // Method 2: Check clock/player indicators
        const whiteIndicator = document.querySelector('.clock-player-turn[data-color="white"], .clock-player-bottom.clock-player-turn');
        if (whiteIndicator) {
            console.log('Turn detected from white clock indicator');
            return 'w';
        }
        
        const blackIndicator = document.querySelector('.clock-player-turn[data-color="black"], .clock-player-top.clock-player-turn');
        if (blackIndicator) {
            console.log('Turn detected from black clock indicator');
            return 'b';
        }

        // Method 3: Look for active/highlighted move indicators
        const activeMoveElement = document.querySelector('.move.active, .move.current, .move.last');
        if (activeMoveElement) {
            const parent = activeMoveElement.closest('.notations, .move-list');
            if (parent) {
                const allMoves = parent.querySelectorAll('.move');
                const activeIndex = Array.from(allMoves).indexOf(activeMoveElement);
                if (activeIndex >= 0) {
                    // Even index = white move, odd = black move
                    // After white's move, it's black's turn (and vice versa)
                    const turn = (activeIndex % 2 === 0) ? 'b' : 'w';
                    console.log('Turn detected from active move indicator:', turn);
                    return turn;
                }
            }
        }

        // Method 4: Count actual half-moves in the DOM (most reliable on chess.com play pages)
        const domHalfMoves = countHalfMovesInDom();
        if (domHalfMoves !== null) {
            const turn = domHalfMoves % 2 === 0 ? 'w' : 'b';
            console.log('Turn detected from DOM half-move count:', turn, 'halfMoves:', domHalfMoves);
            return turn;
        }

        // Method 5: Fallback to passed-in move count parity
        if (typeof movesCount === 'number' && movesCount > 0) {
            const turn = movesCount % 2 === 0 ? 'w' : 'b';
            console.log('Turn detected from passed move count:', turn, 'moves:', movesCount);
            return turn;
        }
    } catch (error) {
        console.warn('Error determining side to move:', error);
    }

    // Default fallback
    console.log('Turn detection fallback: white');
    return 'w';
}

// Helpers for robust FEN/turn handling
function sideToMoveFromFen(fen) {
    try {
        const parts = (fen || '').trim().split(/\s+/);
        if (parts.length >= 2) {
            return parts[1] === 'b' ? 'b' : 'w';
        }
    } catch (_) {}
    return 'w';
}

function normalizeFenForKey(fen) {
    return (fen || '').trim().replace(/\s+/g, ' ');
}

    function getFenFromBoardElement() {
        try {
            console.log('Attempting to extract FEN from board element...');
            
            const boardSelectors = [
                // Modern Chess.com selectors
                'chess-board[data-fen]',
                'chess-board',
                '#board-layout-chessboard chess-board',
                '.board-layout-main chess-board',
                '.board-layout-board chess-board',
                // Legacy selectors
                'cg-board',
                '.board',
                '#board'
            ];

            for (const selector of boardSelectors) {
                console.log(`Trying board selector: ${selector}`);
                const board = document.querySelector(selector);
                if (!board) {
                    console.log(`No element found for: ${selector}`);
                    continue;
                }

                console.log(`Found board element with selector: ${selector}`);
                console.log(`Element attributes:`, Array.from(board.attributes).map(attr => `${attr.name}="${attr.value}"`));

                const attrCandidates = [
                    board.getAttribute('data-fen'),
                    board.dataset?.fen,
                    board.getAttribute('fen'),
                    board.getAttribute('data-position'),
                    board.dataset?.position
                ];

                for (let i = 0; i < attrCandidates.length; i++) {
                    const candidate = attrCandidates[i];
                    if (isLikelyFen(candidate)) {
                        console.log(`Found FEN from attribute ${i}: ${candidate}`);
                        return candidate;
                    } else if (candidate) {
                        console.log(`Attribute ${i} not a valid FEN: ${candidate}`);
                    }
                }

                // Try to parse data-state attribute
                const stateAttr = board.getAttribute('data-state');
                if (stateAttr) {
                    console.log(`Found data-state attribute: ${stateAttr.substring(0, 100)}...`);
                    try {
                        const state = JSON.parse(stateAttr);
                        if (state?.fen && isLikelyFen(state.fen)) {
                            console.log(`Extracted FEN from data-state: ${state.fen}`);
                            return state.fen;
                        }
                        if (state?.position && isLikelyFen(state.position)) {
                            console.log(`Extracted FEN from data-state.position: ${state.position}`);
                            return state.position;
                        }
                    } catch (e) {
                        console.log(`Failed to parse data-state JSON: ${e.message}`);
                    }
                }
            }
            
            console.log('No FEN found in any board element');
        } catch (error) {
            console.warn('Failed to read FEN from board element:', error);
        }
        return null;
    }

    function extractChessComFen() {
        try {
            console.log('Attempting Chess.com specific FEN extraction...');

            const chessComSelectors = [
                // Known globals
                () => window.gameState?.fen,
                () => window.game?.getFEN?.(),
                () => window.game?.fen,
                () => window.chessGame?.fen,
                () => window.chessGame?.getFEN?.(),
                () => window.liveChessGame?.getGame?.()?.getFEN(),
                () => window.liveChess?.game?.fen,
                () => window.liveChess?.chessboard?.fen,
                () => window.liveGame?.fen,
                () => window.liveGame?.game?.fen,
                () => window.LIVE_CHESS?.game?.fen,

                // React root properties
                () => {
                    const root = document.querySelector('#board-layout-main');
                    if (!root) return null;
                    const fiber = root['_reactRootContainer']?.['_internalRoot']?.current || root['_reactInternalFiber'] || root['_reactInternalInstance'];
                    if (!fiber) return null;
                    const searchFiber = (node, depth = 0) => {
                        if (!node || depth > 4) return null;
                        if (node.memoizedProps?.fen && isLikelyFen(node.memoizedProps.fen)) return node.memoizedProps.fen;
                        if (node.memoizedProps?.game?.fen && isLikelyFen(node.memoizedProps.game.fen)) return node.memoizedProps.game.fen;
                        return searchFiber(node.child, depth + 1) || searchFiber(node.sibling, depth + 1);
                    };
                    return searchFiber(fiber);
                },

                // Board element attributes and shadow DOM
                () => {
                    const boardEl = document.querySelector('chess-board');
                    if (!boardEl) return null;

                    const attributeCandidates = [
                        boardEl.getAttribute('data-fen'),
                        boardEl.dataset?.fen,
                        boardEl.getAttribute('fen'),
                        boardEl.getAttribute('current-fen'),
                        boardEl.getAttribute('position'),
                        boardEl.getAttribute('data-position')
                    ];
                    for (const candidate of attributeCandidates) {
                        if (isLikelyFen(candidate)) {
                            return candidate;
                        }
                    }

                    const stateAttr = boardEl.getAttribute('data-state');
                    if (stateAttr) {
                        try {
                            const state = JSON.parse(stateAttr);
                            if (state?.fen && isLikelyFen(state.fen)) return state.fen;
                            if (state?.position && isLikelyFen(state.position)) return state.position;
                        } catch (_) {}
                    }

                    const shadow = boardEl.shadowRoot;
                    if (shadow) {
                        const shadowFenEl = shadow.querySelector('[data-fen], [data-position], [fen]');
                        if (shadowFenEl) {
                            const value = shadowFenEl.getAttribute('data-fen') || shadowFenEl.getAttribute('data-position') || shadowFenEl.getAttribute('fen');
                            if (isLikelyFen(value)) return value;
                        }

                        const shadowStateEl = shadow.querySelector('[data-state]');
                        if (shadowStateEl) {
                            const value = shadowStateEl.getAttribute('data-state');
                            try {
                                const state = value ? JSON.parse(value) : null;
                                if (state?.fen && isLikelyFen(state.fen)) return state.fen;
                            } catch (_) {}
                        }
                    }

                    return deepFenSearch(boardEl, 0, new WeakSet());
                },

                // Deep search known global containers
                () => {
                    const candidates = [
                        window.liveChess,
                        window.liveGame,
                        window.liveChessGame,
                        window.chessGame,
                        window.game,
                        window.gameState
                    ];
                    for (const candidate of candidates) {
                        const result = deepFenSearch(candidate, 0, new WeakSet());
                        if (result) return result;
                    }
                    return null;
                },

                // Embedded JSON blobs
                () => {
                    const scripts = document.querySelectorAll('script[type*="json"], script[data-name*="game"]');
                    for (const script of scripts) {
                        try {
                            const data = JSON.parse(script.textContent || script.innerHTML);
                            if (data?.fen && isLikelyFen(data.fen)) return data.fen;
                            if (data?.game?.fen && isLikelyFen(data.game.fen)) return data.game.fen;
                            if (data?.position && isLikelyFen(data.position)) return data.position;
                        } catch (_) {}
                    }
                    return null;
                },

                // Query parameters
                () => {
                    const urlParams = new URLSearchParams(window.location.search);
                    const fen = urlParams.get('fen');
                    return isLikelyFen(fen) ? fen : null;
                }
            ];

            for (let i = 0; i < chessComSelectors.length; i += 1) {
                try {
                    const fen = chessComSelectors[i]();
                    if (fen && isLikelyFen(fen)) {
                        console.log(`Chess.com FEN extraction method ${i} succeeded: ${fen}`);
                        return fen;
                    }
                } catch (e) {
                    console.log(`Chess.com FEN extraction method ${i} failed: ${e.message}`);
                }
            }

            console.log('No Chess.com specific FEN found');
        } catch (error) {
            console.warn('Chess.com FEN extraction error:', error);
        }
        return null;
    }

    function deepFenSearch(source, depth = 0, visited = new WeakSet()) {
        if (!source) return null;

        if (typeof source === 'string') {
            return isLikelyFen(source) ? source : null;
        }

        if (typeof source === 'function') {
            try {
                const result = source();
                return deepFenSearch(result, depth + 1, visited);
            } catch (_) {
                return null;
            }
        }

        if (typeof source !== 'object') {
            return null;
        }

        if (visited.has(source)) {
            return null;
        }
        visited.add(source);

        if (depth > 4) {
            return null;
        }

        const directProps = ['fen', 'currentFen', 'fenString', 'lastFen', 'boardFen', 'positionFen'];
        for (const prop of directProps) {
            try {
                const value = source[prop];
                if (typeof value === 'string' && isLikelyFen(value)) {
                    return value;
                }
                if (typeof value === 'function') {
                    const result = value();
                    if (isLikelyFen(result)) {
                        return result;
                    }
                }
            } catch (_) {}
        }

        const methodProps = ['getFEN', 'getFen', 'toFen', 'exportFen', 'exportFEN'];
        for (const method of methodProps) {
            try {
                if (typeof source[method] === 'function') {
                    const result = source[method]();
                    if (isLikelyFen(result)) {
                        return result;
                    }
                }
            } catch (_) {}
        }

        try {
            const keys = Object.keys(source);
            for (const key of keys) {
                const value = source[key];
                const result = deepFenSearch(value, depth + 1, visited);
                if (result) {
                    return result;
                }
            }
        } catch (_) {}

        return null;
    }

    function isLikelyFen(value) {
        if (!value || typeof value !== 'string') return false;
        return value.split(' ').length >= 4 && value.includes('/');
    }