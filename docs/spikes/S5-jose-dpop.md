# Spike S5: `jose` DPoP round trip

*Done 12 October 2026 · Node v24.15.0 · `jose` 6.2.12 (pinned exactly, published 5 Sep 2026, `npm audit`: 0 vulnerabilities) · Code: `spikes/S5-jose-dpop/` (git-ignored, to be ported into `poppy-core` in Task 2)*

## Question

Does `jose` cover everything DPoP needs, so that the briefing's `dpopProof` and `verifyDpop` sketches (9.5, 9.6) work as written? Do our `htu` normalisation rules hold?

## Answer

**Yes, with 3 small corrections to the sketches and 4 findings for the build.** `jose` handles signing, verifying against the key embedded in the proof (`EmbeddedJWK`), thumbprints (`calculateJwkThumbprint`, RFC 7638), `typ`, `iat` age and skew, and algorithm pinning. Our code adds `htm`, `htu`, `jti` format, replay, nonce, `ath` and key-binding checks. There are 19 tests (2 positive, 14 negative, plus normalisation and key checks), and all pass.

## Evidence

```
$ node --test dpop.test.ts
ℹ tests 19
ℹ pass 19
ℹ fail 0
```

**Do the tests catch regressions?** I deleted each check in `verifyDpop` in turn and reran the suite. This is a hand-run version of mutation testing.

| Check removed | Result |
|---|---|
| `htm`, `htu`, `jti` format, nonce, `ath`, bound key, replay, `maxTokenAge`, ES256 pin, `typ` | **Killed** (a test fails) |
| Running the replay check before the other checks (so a rejected proof would burn its `jti`) | **Killed** |
| Our own "private key in header" check | **Survived.** `jose`'s `EmbeddedJWK` already rejects a JWK with `d` (`ERR_JWS_INVALID`). Our check is kept as a second layer, and the survivor is expected. |

What `jose` does on its own (probe script):

| Input | `jose` 6.2.12 |
|---|---|
| Private JWK in the proof header | Rejected (`ERR_JWS_INVALID`) |
| Missing `iat` with `maxTokenAge` set | Rejected (`ERR_JWT_CLAIM_VALIDATION_FAILED`) |
| `typ: "DPOP+JWT"` or `"application/dpop+jwt"` | **Accepted**. Media types are case-insensitive, and the `application/` prefix is optional (RFC 7515), so this is correct. |
| `alg: none`, HS256 with an `oct` key | Rejected |
| EdDSA proof (valid asymmetric) | Accepted unless `algorithms: ["ES256"]` is passed, which our code does |

## Corrections to the briefing sketches

1. **`htu` normalisation.** The sketch strips the query and fragment with `new URL()`, which also lowercases the scheme and host and drops default ports. This matches RFC 9449's syntax-based comparison. Tests confirm two more things: a trailing slash **is** significant, and the path **is** case-sensitive. Both sides must use the same `normalizeHtu()` from `poppy-core`, and the company side must build the URL from `PUBLIC_BASE_URL` (risk table, S1).
2. **`jti` check.** The sketch only checks for replay. We also require `jti` to be a string of at least 16 characters (128 bits in base64url), as briefing 9.5 implies with `randomBytes(16)`.
3. **Order of checks.** Record the `jti` in the replay store **only after every other check passes**. Otherwise an attacker could send a broken copy of a captured proof to burn its `jti` and cause a denial of service. The sketch didn't specify an order.

## Findings for the build

| # | Finding | Applied to |
|---|---|---|
| F1 | Node 24 runs `.ts` files directly (type stripping), but only with `"type": "module"`, and **only for syntax that can simply be erased**. Parameter properties (`constructor(private x)`), enums and namespaces fail with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. | Task 1: set `"type": "module"` and `"erasableSyntaxOnly": true` in `tsconfig`. Scripts and tests can run with plain `node` (no `tsx` needed). |
| F2 | `generateKeyPair` creates **non-extractable** keys by default. The agent must save its DPoP keys between runs (one per user per company), so it either generates them as extractable and stores the private JWK in the vault, or keeps them in an OS keystore. | Task 8 (vault design). The private JWK is a vault secret like the Account Token. |
| F3 | Pinning `algorithms: ["ES256"]` is our policy, not a spec requirement. To tell agents about it, the authorization-server metadata should publish `dpop_signing_alg_values_supported: ["ES256"]` (RFC 9449 §5.1). | Task 3 |
| F4 | `typ` is matched case-insensitively and accepts `application/dpop+jwt`, which is correct. No test should expect those to be rejected. | Task 2 tests |

## Plan changes

- Task 1: ESM plus `erasableSyntaxOnly`. Tests can use `node --test` directly, or Vitest as planned. Vitest is still preferred for coverage and mutation-testing (Stryker) integration.
- Task 2: port `dpop.ts` and its 19 tests into `poppy-core` as the starting point, and keep the replay-last order.
- Task 3: add `dpop_signing_alg_values_supported` to the OAuth metadata.
- Task 8: DPoP private keys are vault secrets (F2).
