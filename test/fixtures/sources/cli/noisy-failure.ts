// Writes noisy, markup-laden stderr and fails. The adapter must sanitize and cap what it quotes.
export {};

process.stderr.write("boom\u0007 <b>hi</b>\nsecond ".repeat(200));
process.exitCode = 2;
