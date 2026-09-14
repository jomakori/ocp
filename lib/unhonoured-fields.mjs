// Which OpenAI request fields did this request send that OCP does NOT act on? Pure; no I/O.
//
// WHY THIS EXISTS. #467's harm was that a client believes it has a capability it does not, and the
// failure is invisible on every signal -- HTTP 200, finish_reason "stop", /health ok, clean logs on
// both sides. #468 answered that for `tools` with a counter and a log rather than a refusal, and
// #470 records that `tools` was never the only such field. This is the same answer for the rest.
//
// IT IS NOT A REFUSAL, deliberately. A client that sends `temperature: 0` out of habit must still
// get an answer; 400-ing it would break working integrations to make a point. What changes is that
// the silence is now countable and greppable.
//
// WHY THE CLI CANNOT SIMPLY BE GIVEN THESE. Checked against `claude --help` on 2.1.270: there is no
// --max-tokens, --stop, --seed, --temperature or --top-p. The only budget-shaped flags are
// --max-budget-usd (a DOLLAR cap, not a token cap) and --autocompact (the CONTEXT window, not the
// output). So these are not fields someone forgot to wire -- there is no knob to wire them to, and
// honouring them would mean OCP post-processing the model's output, which is a different decision
// than this module makes.
//
// EXPIRY: this list is the complement of what OCP consumes, and it goes stale the moment a field
// moves into the honoured set. A test asserts that none of these names reaches the spawn's argv, so
// implementing one without removing it here reddens rather than quietly lying.

// Sent-and-inert: OCP neither passes them on nor emulates them.
const ALWAYS_UNHONOURED = [
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "max_completion_tokens",
  "max_tokens",
  "presence_penalty",
  "seed",
  "stop",
  "temperature",
  "top_logprobs",
  "top_p",
];

// `temperature`, `top_p` and `max_tokens` ARE read -- by cacheHash, and nowhere else. That makes
// them cache-key material, not generation parameters: two requests differing only in `temperature`
// occupy different cache entries and get different-but-equally-unsteered answers. Listing them here
// is still correct, because what the client asked for (steer the sampler) does not happen; saying
// they are "completely ignored" would not be, and the distinction is what a reader needs.
export const CACHE_KEY_ONLY = new Set(["temperature", "top_p", "max_tokens"]);

export function listUnhonouredFields(body) {
  if (!body || typeof body !== "object") return [];
  const out = [];
  for (const f of ALWAYS_UNHONOURED) {
    const v = body[f];
    if (v === undefined || v === null) continue;
    // An empty `stop` array asks for nothing, so it is not an unmet request.
    if (f === "stop" && Array.isArray(v) && v.length === 0) continue;
    // `logprobs: false` is the default and asks for nothing.
    if ((f === "logprobs") && v === false) continue;
    out.push(f);
  }
  // `n` is honoured at its default. Only a request for MORE than one choice goes unmet, and that
  // asymmetry matters: reporting `n: 1` would make this fire on clients that are getting exactly
  // what they asked for.
  if (typeof body.n === "number" && body.n !== 1) out.push("n");
  // `parallel_tool_calls: true` IS the behaviour as of #478 -- every call in a message is delivered.
  // Only an explicit `false`, asking OCP to serialise them, goes unmet.
  if (body.parallel_tool_calls === false) out.push("parallel_tool_calls");
  return out.sort();
}
