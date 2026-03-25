/**
 * see.js — Static Exchange Evaluation
 * Estimates the immediate net material gain/loss of a move.
 * Used to filter out "brain-dead" blunders from Maia's probability array.
 */

const PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/**
 * Compute the net material delta (in pawn units) of playing `move`
 * on the given chess.js instance, from the moving side's perspective.
 *
 * Uses a shallow simulation: attacker captures, then opponent's cheapest
 * attacker recaptures, and so on until no attackers remain.
 *
 * @param {Chess} chess  - chess.js instance (not mutated)
 * @param {Object} move  - verbose move object from chess.moves({verbose:true})
 * @returns {number}     - net gain in pawn units (negative = loss)
 */
function evaluateSEE(copy, targetSq) {
  // Find all moves landing on the target square
  const allMoves = copy.moves({ verbose: true });
  const recaptures = allMoves.filter(m => m.to === targetSq);
  if (recaptures.length === 0) return 0;

  // Pick the cheapest attacker
  recaptures.sort((a, b) => {
    const pieceA = copy.get(a.from);
    const pieceB = copy.get(b.from);
    return PIECE_VALUES[pieceA.type] - PIECE_VALUES[pieceB.type];
  });

  const cheapest = recaptures[0];
  let capturedValue = 0;
  if (cheapest.flags.includes('e')) {
    capturedValue = 1;
  } else {
    const capturedPiece = copy.get(targetSq);
    capturedValue = capturedPiece ? PIECE_VALUES[capturedPiece.type] : 0;
  }

  // Make the recapture, evaluate the opponent's response, then undo
  copy.move({ from: cheapest.from, to: targetSq, promotion: 'q' });
  const oppSEE = evaluateSEE(copy, targetSq);
  copy.undo();

  // We can choose to capture (gain = capturedValue - what opponent can do)
  // or stand pat (gain = 0).
  return Math.max(0, capturedValue - oppSEE);
}

function computeSEE(chess, move) {
  const copy = new Chess(chess.fen());
  const targetSq = move.to;

  let capturedValue = 0;
  if (move.flags.includes('e')) {
    capturedValue = 1;
  } else {
    const capturedPiece = copy.get(targetSq);
    capturedValue = capturedPiece ? PIECE_VALUES[capturedPiece.type] : 0;
  }

  // Commit the initial move (cannot stand pat on the very first move)
  copy.move({ from: move.from, to: move.to, promotion: move.promotion || 'q' });
  const oppSEE = evaluateSEE(copy, targetSq);

  return capturedValue - oppSEE;
}

/**
 * Identify the worst hanging piece for the CURRENT side to move (i.e. the opponent
 * of the player who just acted).
 * Returns the maximum material gain the current side can achieve via capture.
 */
function getHangingPenalty(chess) {
  const opponentMoves = chess.moves({ verbose: true });
  let maxGain = 0;

  for (const m of opponentMoves) {
    // We only care about captures to find "hanging" pieces
    if (m.captured) {
      const gain = computeSEE(chess, m);
      if (gain > maxGain) maxGain = gain;
    }
  }

  return maxGain;
}

/**
 * Filter Maia's move probability list by SEE threshold, then re-normalize.
 *
 * @param {Chess}  chess        - current chess.js state
 * @param {Array}  moveProbPairs - [{move: verboseMoveObj, prob: number}, ...]
 * @param {number} threshold    - minimum acceptable SEE value (default -2.0)
 * @returns {Array}             - filtered & re-normalized [{move, prob, see}, ...]
 */
function filterByPlausibility(chess, moveProbPairs, threshold = -2.0) {
  return moveProbPairs.map(pair => {
    // 1. Local SEE (is the target square safe?)
    const moveSee = computeSEE(chess, pair.move);

    // 2. Global Hanging Detection (is something else now hanging?)
    const copy = new Chess(chess.fen());
    copy.move({ from: pair.move.from, to: pair.move.to, promotion: pair.move.promotion || 'q' });
    const globalPenalty = getHangingPenalty(copy);

    const effectiveSee = moveSee - globalPenalty;
    const isPlausible = effectiveSee >= threshold;
    
    return { ...pair, see: effectiveSee, isPlausible };
  });
}

/**
 * Scan all legal moves for those with an SEE >= threshold.
 * Returns an array of verbose move objects.
 */
function scanForHydration(chess, threshold = 2.5) {
  return chess.moves({ verbose: true }).filter(m => {
    if (!m.captured) return false;
    return computeSEE(chess, m) >= threshold;
  });
}

// Export for use as a plain script (no ES modules needed)
window.SEE = { computeSEE, filterByPlausibility, scanForHydration, PIECE_VALUES };
