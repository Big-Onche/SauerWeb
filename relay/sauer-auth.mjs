const P = 0xfffffffffffffffffffffffffffffffeffffffffffffffffn;
const B = 0x64210519e59c80e70fa7e9ab72243049feb8deecc146b9b1n;

// Original: .Sauerbraten/src/shared/crypto.cpp, answerchallenge(). Sauerbraten serializes bigint values in padded 16-bit limbs.
export function answerChallenge(privateKey, challenge) {
  if (!/^[0-9a-fA-F]{1,48}$/.test(privateKey) || BigInt(`0x${privateKey}`) === 0n) throw new Error("Invalid private key");
  const match = /^([+-])([0-9a-fA-F]{1,48})$/.exec(challenge);
  if (!match) throw new Error("Invalid Sauerbraten authentication challenge");
  const x = BigInt(`0x${match[2]}`);
  if (x >= P) throw new Error("Invalid Sauerbraten authentication challenge");
  const ySquared = mod(x * x * x - 3n * x + B);
  let y = modPow(ySquared, (P + 1n) / 4n);
  if (mod(y * y) !== ySquared) throw new Error("Invalid Sauerbraten authentication challenge");
  const odd = (y & 1n) === 1n;
  if (odd !== (match[1] === "-")) y = P - y;
  const answer = multiply({ x, y }, BigInt(`0x${privateKey}`));
  if (!answer) throw new Error("Invalid Sauerbraten authentication result");
  const digits = answer.x.toString(16);
  return digits.padStart(Math.ceil(digits.length / 4) * 4, "0");
}

function multiply(point, scalar) {
  let result = null, addend = point;
  while (scalar > 0n) {
    if (scalar & 1n) result = add(result, addend);
    addend = add(addend, addend);
    scalar >>= 1n;
  }
  return result;
}

function add(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (left.x === right.x && mod(left.y + right.y) === 0n) return null;
  const slope = left.x === right.x && left.y === right.y
    ? mod((3n * left.x * left.x - 3n) * inverse(2n * left.y))
    : mod((right.y - left.y) * inverse(right.x - left.x));
  const x = mod(slope * slope - left.x - right.x);
  return { x, y: mod(slope * (left.x - x) - left.y) };
}

function inverse(value) { return modPow(mod(value), P - 2n); }
function mod(value) { const result = value % P; return result < 0n ? result + P : result; }
function modPow(base, exponent) {
  let result = 1n;
  for (base = mod(base); exponent > 0n; exponent >>= 1n, base = mod(base * base)) if (exponent & 1n) result = mod(result * base);
  return result;
}
