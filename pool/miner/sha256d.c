// Saturn browser miner: SHA-256d over 80-byte block headers, as fast as WebAssembly allows.
//
// Per nonce it does 2 compressions instead of 3 (the header's first 64 bytes never change, so their
// "midstate" is computed once per job), starts the second compression after its first three rounds
// (they only depend on the job, not the nonce), and only looks at the hash's top 64 bits per nonce,
// leaving the full comparison to JavaScript for the rare candidate.
// Built twice: with SIMD (4 nonces per instruction) and plain, for browsers without SIMD.
#include <stdint.h>

#ifdef SIMD
#include <wasm_simd128.h>
typedef v128_t V;
#define LANES 4
#define SPLAT(x) wasm_i32x4_splat((int32_t)(x))
#define ADD(a, b) wasm_i32x4_add(a, b)
#define XOR(a, b) wasm_v128_xor(a, b)
#define AND(a, b) wasm_v128_and(a, b)
#define OR(a, b) wasm_v128_or(a, b)
#define SHR(x, n) wasm_u32x4_shr(x, n)
#define ROTR(x, n) wasm_v128_or(wasm_u32x4_shr(x, n), wasm_i32x4_shl(x, 32 - (n)))
#define BSWAP(x) wasm_i8x16_shuffle(x, x, 3, 2, 1, 0, 7, 6, 5, 4, 11, 10, 9, 8, 15, 14, 13, 12)
#define LANE(v, i) ((uint32_t)wasm_i32x4_extract_lane(v, i))
#else
typedef uint32_t V;
#define LANES 1
#define SPLAT(x) ((uint32_t)(x))
#define ADD(a, b) ((a) + (b))
#define XOR(a, b) ((a) ^ (b))
#define AND(a, b) ((a) & (b))
#define OR(a, b) ((a) | (b))
#define SHR(x, n) ((x) >> (n))
#define ROTR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))
#define BSWAP(x) __builtin_bswap32(x)
#endif

#define CH(e, f, g) XOR(g, AND(e, XOR(f, g)))
#define MAJ(a, b, c) OR(AND(a, b), AND(c, OR(a, b)))
#define S0(a) XOR(XOR(ROTR(a, 2), ROTR(a, 13)), ROTR(a, 22))
#define S1(e) XOR(XOR(ROTR(e, 6), ROTR(e, 11)), ROTR(e, 25))
#define s0(x) XOR(XOR(ROTR(x, 7), ROTR(x, 18)), SHR(x, 3))
#define s1(x) XOR(XOR(ROTR(x, 17), ROTR(x, 19)), SHR(x, 10))

static const uint32_t K[64] = {
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};
static const uint32_t IV[8] = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 };

// Shared with JavaScript (all words as SHA-256 sees them, i.e. big-endian):
//   io[0..19]   in:  the 80-byte header as 20 words (nonce word ignored)
//   io[20]      in:  target, top 32 bits      io[21] in: target, next 32 bits
//   io[24..55]  out: candidate nonces from scan() (up to 32)
//   io[56..63]  out: hash_header()'s double SHA-256
static uint32_t io_buf[64];
uint32_t *io(void) { return io_buf; }

// per job, from prepare(): midstate, and the second chunk's state after its first 3 rounds
static uint32_t mid[8], pre[8], w0, w1, w2;

// plain 32-bit helpers for the once-per-job work (prepare, hash_header)
#define RR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))
#define SS0(a) (RR(a, 2) ^ RR(a, 13) ^ RR(a, 22))
#define SS1(e) (RR(e, 6) ^ RR(e, 11) ^ RR(e, 25))
#define ss0(x) (RR(x, 7) ^ RR(x, 18) ^ ((x) >> 3))
#define ss1(x) (RR(x, 17) ^ RR(x, 19) ^ ((x) >> 10))
#define SCH(e, f, g) ((g) ^ ((e) & ((f) ^ (g))))
#define SMAJ(a, b, c) (((a) & (b)) | ((c) & ((a) | (b))))

static void compress1(uint32_t st[8], const uint32_t blk[16]) {
  uint32_t w[64];
  for (int i = 0; i < 16; i++) w[i] = blk[i];
  for (int i = 16; i < 64; i++) w[i] = ss1(w[i - 2]) + w[i - 7] + ss0(w[i - 15]) + w[i - 16];
  uint32_t a = st[0], b = st[1], c = st[2], d = st[3], e = st[4], f = st[5], g = st[6], h = st[7];
  for (int i = 0; i < 64; i++) {
    uint32_t t1 = h + SS1(e) + SCH(e, f, g) + K[i] + w[i], t2 = SS0(a) + SMAJ(a, b, c);
    h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
  }
  st[0] += a; st[1] += b; st[2] += c; st[3] += d; st[4] += e; st[5] += f; st[6] += g; st[7] += h;
}

void prepare(void) {
  for (int i = 0; i < 8; i++) mid[i] = IV[i];
  compress1(mid, io_buf);
  w0 = io_buf[16]; w1 = io_buf[17]; w2 = io_buf[18];
  uint32_t a = mid[0], b = mid[1], c = mid[2], d = mid[3], e = mid[4], f = mid[5], g = mid[6], h = mid[7];
  const uint32_t ws[3] = { w0, w1, w2 };
  for (int i = 0; i < 3; i++) {
    uint32_t t1 = h + SS1(e) + SCH(e, f, g) + K[i] + ws[i], t2 = SS0(a) + SMAJ(a, b, c);
    h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
  }
  pre[0] = a; pre[1] = b; pre[2] = c; pre[3] = d; pre[4] = e; pre[5] = f; pre[6] = g; pre[7] = h;
}

// full double SHA-256 of the header in io with this nonce, into io[56..63] (to double-check a find)
void hash_header(uint32_t nonce) {
  uint32_t st[8], blk[16];
  for (int i = 0; i < 8; i++) st[i] = IV[i];
  compress1(st, io_buf);
  blk[0] = io_buf[16]; blk[1] = io_buf[17]; blk[2] = io_buf[18]; blk[3] = __builtin_bswap32(nonce);
  blk[4] = 0x80000000; for (int i = 5; i < 15; i++) blk[i] = 0; blk[15] = 640;
  compress1(st, blk);
  uint32_t st2[8];
  for (int i = 0; i < 8; i++) { st2[i] = IV[i]; blk[i] = st[i]; }
  blk[8] = 0x80000000; for (int i = 9; i < 15; i++) blk[i] = 0; blk[15] = 256;
  compress1(st2, blk);
  for (int i = 0; i < 8; i++) io_buf[56 + i] = st2[i];
}

#define ROUND(a, b, c, d, e, f, g, h, k, w) do { \
    V t1_ = ADD(ADD(ADD(h, S1(e)), ADD(CH(e, f, g), SPLAT(k))), w); \
    V t2_ = ADD(S0(a), MAJ(a, b, c)); \
    d = ADD(d, t1_); h = ADD(t1_, t2_); } while (0)

// 8 rounds with the register names rotating, so nothing is copied between rounds
#define R8(i) \
  ROUND(a, b, c, d, e, f, g, h, K[i + 0], W[i + 0]); ROUND(h, a, b, c, d, e, f, g, K[i + 1], W[i + 1]); \
  ROUND(g, h, a, b, c, d, e, f, K[i + 2], W[i + 2]); ROUND(f, g, h, a, b, c, d, e, K[i + 3], W[i + 3]); \
  ROUND(e, f, g, h, a, b, c, d, K[i + 4], W[i + 4]); ROUND(d, e, f, g, h, a, b, c, K[i + 5], W[i + 5]); \
  ROUND(c, d, e, f, g, h, a, b, K[i + 6], W[i + 6]); ROUND(b, c, d, e, f, g, h, a, K[i + 7], W[i + 7])

// Try nonces start .. start+count-1 (count a multiple of LANES). Returns how many candidates it
// wrote to io[24..]: nonces whose hash's top 64 bits are at or under the target's (JavaScript then
// checks the whole hash).
uint32_t scan(uint32_t start, uint32_t count) {
  const uint32_t thi = io_buf[20], tlo = io_buf[21];
  uint32_t found = 0;
#ifdef SIMD
  const V step = wasm_i32x4_make(0, 1, 2, 3);
#endif
  for (uint32_t n = start; n - start < count; n += LANES) {
    V W[64];
    // ---- second chunk of the header: rounds 3..63 ----
    W[0] = SPLAT(w0); W[1] = SPLAT(w1); W[2] = SPLAT(w2);
#ifdef SIMD
    V nonce = ADD(SPLAT(n), step);
#else
    V nonce = n;
#endif
    W[3] = BSWAP(nonce);
    W[4] = SPLAT(0x80000000);
    for (int i = 5; i < 15; i++) W[i] = SPLAT(0);
    W[15] = SPLAT(640);
    for (int i = 16; i < 64; i++) W[i] = ADD(ADD(s1(W[i - 2]), W[i - 7]), ADD(s0(W[i - 15]), W[i - 16]));
    // pre[] is the state entering round 3; with rotating names, round 3 reads a..h from f,g,h,a,b,c,d,e
    V f = SPLAT(pre[0]), g = SPLAT(pre[1]), h = SPLAT(pre[2]), a = SPLAT(pre[3]);
    V b = SPLAT(pre[4]), c = SPLAT(pre[5]), d = SPLAT(pre[6]), e = SPLAT(pre[7]);
    // rounds 3..7, then 8..63 (rounds 0..2 are in pre[]); registers rotate as if round 0 had been first
    ROUND(f, g, h, a, b, c, d, e, K[3], W[3]); ROUND(e, f, g, h, a, b, c, d, K[4], W[4]);
    ROUND(d, e, f, g, h, a, b, c, K[5], W[5]); ROUND(c, d, e, f, g, h, a, b, K[6], W[6]);
    ROUND(b, c, d, e, f, g, h, a, K[7], W[7]);
    R8(8); R8(16); R8(24); R8(32); R8(40); R8(48); R8(56);
    // after round 63 the names are back in order: hash 1 = midstate + a..h
    V H0 = ADD(SPLAT(mid[0]), a), H1 = ADD(SPLAT(mid[1]), b), H2 = ADD(SPLAT(mid[2]), c), H3 = ADD(SPLAT(mid[3]), d);
    V H4 = ADD(SPLAT(mid[4]), e), H5 = ADD(SPLAT(mid[5]), f), H6 = ADD(SPLAT(mid[6]), g), H7 = ADD(SPLAT(mid[7]), h);
    // ---- second SHA-256 over the 32-byte hash ----
    W[0] = H0; W[1] = H1; W[2] = H2; W[3] = H3; W[4] = H4; W[5] = H5; W[6] = H6; W[7] = H7;
    W[8] = SPLAT(0x80000000);
    for (int i = 9; i < 15; i++) W[i] = SPLAT(0);
    W[15] = SPLAT(256);
    for (int i = 16; i < 64; i++) W[i] = ADD(ADD(s1(W[i - 2]), W[i - 7]), ADD(s0(W[i - 15]), W[i - 16]));
    a = SPLAT(IV[0]); b = SPLAT(IV[1]); c = SPLAT(IV[2]); d = SPLAT(IV[3]);
    e = SPLAT(IV[4]); f = SPLAT(IV[5]); g = SPLAT(IV[6]); h = SPLAT(IV[7]);
    R8(0); R8(8); R8(16); R8(24); R8(32); R8(40); R8(48); R8(56);
    // after 64 rounds the names are back in order: final words 6 and 7 are IV + g, IV + h
    V F7 = BSWAP(ADD(SPLAT(IV[7]), h)), F6 = BSWAP(ADD(SPLAT(IV[6]), g));
#ifdef SIMD
    // any lane with top word <= target's? (unsigned compare via the sign-flip trick)
    V flip = SPLAT(0x80000000);
    V le = wasm_i32x4_le(XOR(F7, flip), XOR(SPLAT(thi), flip));
    if (wasm_v128_any_true(le)) {
      uint32_t t7s[4] = { LANE(F7, 0), LANE(F7, 1), LANE(F7, 2), LANE(F7, 3) };
      uint32_t t6s[4] = { LANE(F6, 0), LANE(F6, 1), LANE(F6, 2), LANE(F6, 3) };
      for (int i = 0; i < 4; i++) {
        if (t7s[i] < thi || (t7s[i] == thi && t6s[i] <= tlo)) { if (found < 32) io_buf[24 + found] = n + i; found++; }
      }
    }
#else
    if (F7 < thi || (F7 == thi && F6 <= tlo)) { if (found < 32) io_buf[24 + found] = n; found++; }
#endif
  }
  return found < 32 ? found : 32;
}
