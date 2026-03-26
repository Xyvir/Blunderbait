const { Chess } = require('./chess.js');
const SEE = require('./see.js').SEE;

const fen = 'rn2kb1r/pp2pppp/2pp1n2/6N1/3P4/2N1P2P/PPP2PP1/R2bKB1R w KQkq - 0 8';
const chess = new Chess(fen);

console.log('Board FEN:', fen);
console.log('White to move:', chess.turn() === 'w');

const moves = chess.moves({ verbose: true });
console.log(`Found ${moves.length} legal moves.`);

const hydrationCandidates = moves.filter(m => {
  if (!m.captured) return false;
  const score = SEE.computeSEE(chess, m);
  console.log(`Move: ${m.san} (${m.from}${m.to}), Captured: ${m.captured}, SEE: ${score}`);
  return score >= 1.5;
});

console.log('\nHydration Candidates:');
hydrationCandidates.forEach(m => {
  console.log(`- ${m.san} (SEE: ${SEE.computeSEE(chess, m)})`);
});

console.log('\n--- EP Test ---');
const epFen = 'rnbqkbnr/pppp1ppp/8/3Pp3/8/8/PPP1PPPP/RNBQKBNR w KQkq e6 0 3';
const epChess = new Chess(epFen);
const epMove = epChess.moves({verbose:true}).find(m => m.san === 'dxe6');
if (epMove) {
  const score = SEE.computeSEE(epChess, epMove);
  console.log(`EP Move: ${epMove.san}, Captured: ${epMove.captured}, SEE: ${score}`);
} else {
  console.log('EP move not found in dxe6 test case');
}
