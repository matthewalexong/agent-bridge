import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRAIN = path.join(root, "eval/search/live/hermes-brain.mjs");
const PANEL_SKILL = path.join(root, "eval/search/skills/panel-chat-skill-v3.md");
const LIVE_PANEL_SKILL = path.join(root, "eval/search/skills/agent-bridge-panel.md");

test("panel skill uses live progress instead of a final Why block", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /panel shows live progress/i);
  assert.doesNotMatch(skill, /add a short reasoning summary/i);
});

test("live panel shopping does not collapse broad technical categories to one brand and preserves source links", async () => {
  const skill = await fs.readFile(LIVE_PANEL_SKILL, "utf8");
  assert.match(skill, /brand-neutral queries/i);
  assert.match(skill, /unified, shared, coherent, or CPU\/GPU-addressable memory is not an Apple constraint/i);
  assert.match(skill, /at least two materially different architectures and three product families/i);
  assert.match(skill, /Never treat two pages about one brand as market coverage/i);
  assert.match(skill, /candidate extraction returns zero.*broaden the third search/is);
  assert.match(skill, /pass up to five fresh snapshot IDs from source or product pages actually opened in `source_snapshot_ids`/i);
  assert.match(skill, /every named product, current price, or availability claim needs a corresponding card/i);
  assert.match(skill, /Bare domains in text do not count as links/i);
});

test("panel skill batches evidence domains without making local models architectural", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /use one bounded `SEARCH_BATCH` for two\s+to four independent lanes/i);
  assert.match(skill, /never create one agent or one search lane per checklist item/i);
  assert.match(skill, /executes batch queries concurrently and deduplicates normalized\s+query text/i);
  assert.match(skill, /call\s+`browser_snapshot_batch` for up to eight tabs instead of serial snapshots/i);
  assert.match(skill, /`shopping_page_evidence_batch` in one bounded\s+call/i);
  assert.match(skill, /reuses extraction only when signed content,\s+page kind, seller query, and directory-completeness scope are identical/i);
  assert.match(skill, /never treat a partial batch as\s+complete/i);
  assert.match(skill, /call `shopping_evaluator_batch` to run ready\s+independent and explicitly dependent deterministic checks as one validated\s+acyclic graph/i);
  assert.match(skill, /inspect its returned\s+signed `candidate_offers` once, then pass only its `candidate_offers_ref`/i);
  assert.match(skill, /prevents that large\s+page-evidence payload from being resent/i);
  assert.match(skill, /deterministic in-process check.*adds no\s+model call or search round trip/is);
  assert.match(skill, /intentionally omits a\s+duplicate\s+top-level `artifacts`\s+array/i);
  assert.match(skill, /omit\s+`listing_evidence` from identity, promotion, safety, merchant, counterfeit/i);
  assert.match(skill, /removes repeated payload tokens/i);
  assert.match(skill, /Use the default `result_mode=compact`/i);
  assert.match(skill, /complete result entry for the exact context product or offer/i);
  assert.match(skill, /Cross-candidate selection\s+outputs remain complete/i);
  assert.match(skill, /`wave\.saved_result_chars` report the character savings/i);
  assert.match(skill, /pass only the returned\s+`decision_context_ref`/i);
  assert.match(skill, /avoiding repeated request-receipt, constraint, and applicability\s+tokens/i);
  assert.match(skill, /unknown reference after a process\s+restart.*fails closed/is);
  assert.match(skill, /call `browser_panel_post` with `kind=products` and `recommendation_state=provisional`/i);
  assert.match(skill, /final winner requires `recommendation_state=verified`.*`recommendation_ref`/is);
  assert.match(skill, /Verified posts automatically append a bounded process-derived detail line.*landed total.*delivery window.*return window.*counterfeit-risk status/is);
  assert.match(skill, /unhydrated candidates are rejected and unknown facts remain explicit/i);
  assert.doesNotMatch(skill, /show it as a LINK CARD via the `links` parameter/i);
  assert.match(skill, /at most one job for each evaluator stage/i);
  assert.match(skill, /rejects all three mistakes before invoking a tool/i);
  assert.match(skill, /`wave\.wall_time_ms` to identify genuinely slow/i);
  assert.match(skill, /call `shopping_request_intake` with\s+the runtime-provided panel message ID/i);
  assert.match(skill, /Account for every returned clause exactly\s+once as `objective`, `constraint`, `objective_and_constraint`, `context`, or\s+`nonshopping`/i);
  assert.match(skill, /Every normalized constraint\s+must cite its `source_clause_ids`/i);
  assert.match(skill, /This is a small local provenance call, not an inference\s+call/i);
  assert.match(skill, /Treat every returned `literal_fact` as process-owned authority/i);
  assert.match(skill, /changed value, unit,\s+currency, comparison direction, deadline, or polarity invalidates the context/i);
  assert.match(skill, /An `unknown` comparison operator stays unknown and requires clarification/i);
  assert.match(skill, /batch signs this\s+context in the same call, so it adds no separate model round trip/i);
  assert.match(skill, /changed user request,\s+profile revision, destination, constraint, applicability decision, product, or\s+offer is a new context/i);
  assert.match(skill, /Leave `dependency_mode=auto` and omit standard dependency artifacts/i);
  assert.match(skill, /identity-to-safety\/merchant\/counterfeit\/\s*protection\/fulfillment edges/i);
  assert.match(skill, /nonstandard diagnostic graph only, set `dependency_mode=explicit`/i);
  assert.match(skill, /`argument_bindings: \[\{from_job_id, target_key\}\]`/i);
  assert.match(skill, /auto mode runs the\s+standard three-layer graph/i);
  assert.match(skill, /failed upstream job suppresses every\s+dependent job without executing it/i);
  assert.match(skill, /Compact\s+output never becomes dependency input/i);
  assert.match(skill, /`wave\.dependency_input_chars_saved` reports the artifact payload the main brain\s+did not have to resend/i);
  assert.match(skill, /job marked `complete` means it executed, not that its product or\s+offer cleared/i);
  assert.match(skill, /readiness object always leaves `recommendation_ready` and\s+`purchase_allowed` false/i);
  assert.match(skill, /call `shopping_decision_dossier` separately/i);
  assert.match(skill, /rejects missing, expired, altered, mixed-context, forged, edited/i);
  assert.match(skill, /no local\s+model may plan a wave/i);
  assert.match(skill, /declare the exact `subject\.product_id` and.*`subject\.offer_id`/is);
  assert.match(skill, /creates a `dossier_stage` carrying a\s+process-only attestation/i);
  assert.match(skill, /default `stage_mode=reference`/i);
  assert.match(skill, /returns only the latest\s+`dossier_stages_ref`/i);
  assert.match(skill, /Pass the latest\s+reference to `shopping_decision_dossier`/i);
  assert.match(skill, /failed attempted rerun removes the\s+older copy of that stage/i);
  assert.match(skill, /never create, edit, retype, merge, or repair a returned full stage/i);
  assert.match(skill, /production dossier derives phase, product, offer, and applicability from that\s+context/i);
  assert.match(skill, /no local\s+model may.*transport a partial stage/is);
  assert.match(skill, /main brain still owns the plan, applicability, narrowing, and synthesis/i);
  assert.match(skill, /Surface a provisional candidate set as soon as discovery yields exact-scope\s+leads/i);
  assert.match(skill, /Never call a provisional candidate the winner\s+or bypass a gate merely to reduce latency/i);
  assert.match(skill, /No Gemma or other local model is a\s+component, lane, scheduler, router, cache, source of truth, or prerequisite/i);
  assert.match(skill, /Generic terms such as unified, shared, coherent, or CPU\/GPU-addressable\s+memory are technical requirements, not synonyms for Apple/i);
  assert.match(skill, /Two pages about\s+one brand never establish market coverage/i);
  assert.match(skill, /post `kind=none` with up to five fresh snapshot IDs from source or product pages actually opened in `source_snapshot_ids`/i);
  assert.match(skill, /bare domain written in the reply is not a link card/i);
});

test("panel skill requires a bounded evidence-based research trail without chain-of-thought", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /use `browser_panel_status` before the\s+first research action/i);
  assert.match(skill, /after each material evidence or decision\s+milestone/i);
  assert.match(skill, /Do not emit a status for every low-level click/i);
  assert.match(skill, /up to five supportable facts/i);
  assert.match(skill, /automatically attached to the final panel answer as a\s+collapsible research trail/i);
  assert.match(skill, /audit summary, not hidden chain-of-\s*thought/i);
  assert.match(skill, /Never expose private scratch work.*security\s+secrets/is);
  assert.match(skill, /Never write a generic update such as “thinking,” “research in\s+progress,” or “working on it”/i);
  assert.match(skill, /final answer should not repeat the trail/i);
  assert.match(skill, /Gemma must not create conclusions, infer evidence/i);
});

test("panel skill makes personal shopping memory explicit, scoped, expiring, and forgettable", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /applies to the current request only.*Do not store it unless the user\s+explicitly asks/is);
  assert.match(skill, /Never infer\s+or save a profile field from browsing behavior, search history, purchases/i);
  assert.match(skill, /exact field,\s+value, decision role, scope, sensitivity, and expiry/i);
  assert.match(skill, /`never_expires` requires a separate explicit permanent-memory request/i);
  assert.match(skill, /Sizes, body measurements, accessibility needs, and ingredient-related fields\s+are sensitive/i);
  assert.match(skill, /each future request needs\s+fresh authorization/i);
  assert.match(skill, /Never store passwords, API keys, tokens,\s+payment-card or bank data/i);
  assert.match(skill, /call `shopping_profile_resolve` before\s+preference ranking/i);
  assert.match(skill, /Product-scoped values override\s+category values, which override global values/i);
  assert.match(skill, /If `requires_clarification` is\s+true.*never choose one\s+silently/is);
  assert.match(skill, /does not verify a product fact, seller, price, stock/i);
  assert.match(skill, /deletion is immediate and nonrecoverable/i);
  assert.match(skill, /Gemma must not infer or save memory/i);
});

test("panel skill requires fully landed cost and fulfillment evidence before offer comparison", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /call\s+`shopping_fulfillment_assess` for the exact offer and destination/i);
  assert.match(skill, /Item price\s+plus advertised shipping is not a fully landed cost/i);
  assert.match(skill, /sales or\s+import tax, import duty, customs brokerage, carrier surcharges, and currency-\s*conversion fees/i);
  assert.match(skill, /never makes an omitted charge zero/i);
  assert.match(skill, /Preserve low\/expected\/high ranges/i);
  assert.match(skill, /ships-from country, destination eligibility, Incoterm/i);
  assert.match(skill, /compare the entire window with any user-required date/i);
  assert.match(skill, /Cross-border returns are\s+not equivalent to local free returns/i);
  assert.match(skill, /`avoid_offer` excludes the offer even when its advertised price is lowest/i);
  assert.match(skill, /Use `fully_landed_total_usd`—not item-plus-shipping/i);
  assert.match(skill, /Raw discount fields never reduce the\s+ledger/i);
  assert.match(skill, /convert each through `shopping_page_evidence`/i);
  assert.match(skill, /Never submit raw\s+price, charge, exact-identity, route, delivery, return, destination, or evidence-\s*status fields/i);
  assert.match(skill, /offer tool verifies the fulfillment attestation/i);
  assert.match(skill, /unsigned promotion\s+output never reduces the signed ledger/i);
  assert.match(skill, /pass the complete fresh returned fulfillment\s+artifact to `shopping_offer_analyze`/i);
  assert.match(skill, /If estimated ranges overlap.*worst case/is);
  assert.match(skill, /Unit-cost ranking requires exact landed\s+cost/i);
  assert.match(skill, /mismatch is a hard composition failure/i);
  assert.match(skill, /Gemma must not infer a zero charge/i);
});

test("panel skill requires typed sourced compatibility before ranking", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /call `shopping_compatibility_assess` before preference\s+ranking/i);
  assert.match(skill, /Product identity and “compatible with” marketing do not prove fit/i);
  assert.match(skill, /Do not\s+infer body measurements, vehicle trim\/engine, host model, electrical service/i);
  assert.match(skill, /fresh sensitive-\s*data authorization required by `shopping_profile_resolve`/i);
  assert.match(skill, /Every candidate claim must carry a concrete `source_id`/i);
  assert.match(skill, /size label alone, or incomplete table is not verified compatibility/i);
  assert.match(skill, /A no-fit conclusion is definitive only when fitment\s+coverage is explicitly complete/i);
  assert.match(skill, /A plug adapter does not convert voltage or frequency/i);
  assert.match(skill, /include required clearance on both sides of every axis/i);
  assert.match(skill, /`incompatible` excludes that exact candidate\/configuration/i);
  assert.match(skill, /Gemma must not infer measurements or fitment/i);
});

test("panel skill requires authoritative exact-scope safety clearance for every recommendation", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /call `shopping_safety_assess` for the user's actual\s+jurisdiction/i);
  assert.match(skill, /product category must come from signed manufacturer-product\s+evidence inside the identity artifact/i);
  assert.match(skill, /do not submit, restate, infer, or\s+substitute a category at the safety boundary/i);
  assert.match(skill, /“No result found,” a general\s+web search, retailer silence, an old search, or\s+one database is not proof/i);
  assert.match(skill, /coverage entry for every required authority/i);
  assert.match(skill, /exclude search\s+snippets, customer posts, retailer summaries, and unverified recall claims/i);
  assert.match(skill, /serial number or manufacture date.*keep applicability unknown/is);
  assert.match(skill, /Do not transfer a recall from a similar model/i);
  assert.match(skill, /cleared only by a verified exact-unit remediation record/i);
  assert.match(skill, /sales or import ban cannot be overridden/i);
  assert.match(skill, /Certification does not substitute for recall\s+coverage/i);
  assert.match(skill, /Safety is never an optional applicability stage/i);
  assert.match(skill, /pass the complete fresh safety artifact to `shopping_offer_analyze` and\s+later to `shopping_checkout_preflight`/i);
  assert.match(skill, /exact offer, product,\s+variant, condition, seller, and destination jurisdiction/i);
  assert.match(skill, /never\s+reconstruct or downgrade a recall, ban, certification/i);
  assert.match(skill, /Gemma must not declare coverage complete/i);
  assert.match(skill, /Do not choose, trim, or submit the required-regulator set/i);
  assert.match(skill, /process-owned jurisdiction\/category policy/i);
});

test("panel skill makes connected-product privacy a sourced non-averagable gate", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /call\s+`shopping_privacy_assess` before preference ranking/i);
  assert.match(skill, /generic “privacy is not relevant” skip is invalid/i);
  assert.match(skill, /Use only the user's stated privacy requirements or consent-scoped remembered\s+privacy fields/i);
  assert.match(skill, /Each policy, data flow, permission, control, architecture fact, and\s+incident needs its own real source identity/i);
  assert.match(skill, /Record policy capture time and whether the data inventory is complete/i);
  assert.match(skill, /Optional prohibited data is\s+acceptable only when a verified control actually disables it/i);
  assert.match(skill, /Factory reset, unlink, and transfer are separate resale gates/i);
  assert.match(skill, /unresolved critical\/serious applicable\s+incident is a hard failure/i);
  assert.match(skill, /Privacy analysis remains separate from lifecycle/i);
  assert.match(skill, /Gemma must not infer user tolerance/i);
});

test("panel skill keeps exact-formulation composition checks explicit and nonmedical", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /call\s+`shopping_composition_assess` before preference ranking/i);
  assert.match(skill, /not medical diagnosis or treatment advice/i);
  assert.match(skill, /Ingredient avoidances are\s+sensitive: obtain fresh authorization/i);
  assert.match(skill, /Never invent chemical families, botanical equivalence, allergen relationships/i);
  assert.match(skill, /formulation ID, region, and version/i);
  assert.match(skill, /ingredients and materials separate/i);
  assert.match(skill, /Direct contains is a hard conflict/i);
  assert.match(skill, /Marketing language cannot satisfy a certification\s+requirement/i);
  assert.match(skill, /Never turn ingredient-list omission into allergen\s+clearance/i);
  assert.match(skill, /Gemma\s+must not infer aliases, allergens, safe concentrations/i);
});

test("panel skill requires fresh checkout preflight and post-summary confirmation", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /shopping_checkout_evidence/);
  assert.match(skill, /shopping_checkout_preflight/);
  assert.match(skill, /shopping_checkout_consent_assess/);
  assert.match(skill, /shopping_checkout_terms_challenge/);
  assert.match(skill, /shopping_checkout_terms_accept/);
  assert.match(skill, /shopping_checkout_terms_evidence/);
  assert.match(skill, /shopping_checkout_pattern_observe/);
  assert.match(skill, /Bind `expected\.product_key`,\s+`expected\.offer_id`, and the matching cart item/i);
  assert.match(skill, /Pass both the exact `terms_evidence`\s+and its complete unchanged `pattern_evidence` to\s+`shopping_checkout_consent_assess`/i);
  assert.match(skill, /Never reorder\s+or omit observations to erase history/i);
  assert.match(skill, /not proof or an accusation of fraud/i);
  assert.match(skill, /shopping_confirmation_challenge/);
  assert.match(skill, /shopping_confirmation_accept/);
  assert.match(skill, /Wait for a NEW[\n ]+panel message/i);
  assert.match(skill, /purchase_allowed.*external_submission_allowed.*false/is);
  assert.match(skill, /Never set `confirmed: true`/);
  assert.match(skill, /Unexpected cart items are a\s+mismatch/);
  assert.match(skill, /Pass the same complete fresh exact-offer counterfeit artifact used to clear\s+ranking into `shopping_checkout_preflight`/i);
  assert.match(skill, /seller swap requires new merchant and authenticity verification/i);
  assert.match(skill, /prechecked box, UI click, prior message, agent inference[\s\S]*never informed consent/i);
  assert.match(skill, /Optional selected add-ons without fresh acceptance[\s\S]*must be removed/i);
  assert.match(skill, /Subscription, membership, and trial-to-paid terms require a fresh\s+process-attested acknowledgement receipt/i);
  assert.match(skill, /Never submit caller-authored `acknowledgement`, `user_intent`/i);
  assert.match(skill, /Never submit caller-authored purchase terms, add-on arrays/i);
  assert.match(skill, /Unverified urgency is disregarded/i);
  assert.match(skill, /Gemma[\s\S]*must not infer consent/i);
});

test("panel skill gates risk scoring and offer comparison on canonical identity", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /shopping_identity_resolve/);
  assert.match(skill, /complete signed `target_evidence` plus\s+each candidate's complete signed `listing_evidence`/i);
  assert.match(skill, /Do not transcribe brand, line, model, generation,\s+edition, region, capacity, size, color, bundle, identifier, compatibility, or\s+condition fields/i);
  assert.match(skill, /automatically requires every identity field observed on the\s+signed target page/i);
  assert.match(skill, /cannot supply, remove, or mark required fields as\s+flexible/i);
  assert.match(skill, /condition-free page evidence fails closed/i);
  assert.match(skill, /BEFORE counterfeit-risk scoring,\s+offer analysis,\s+ranking, or price comparison/i);
  assert.match(skill, /Only candidates classified as\s+`exact_match` with `safe_to_compare_offers: true`/i);
  assert.match(skill, /`compatible_alternative` is not the requested product/i);
  assert.match(skill, /For `insufficient_evidence`, verify the missing identity fields/i);
  assert.match(skill, /Pass the complete fresh returned identity artifact[\s\S]*to `shopping_offer_analyze` and\s+later to `shopping_checkout_preflight`/i);
  assert.match(skill, /matching offer ID, target product,\s+variant, and condition/i);
  assert.match(skill, /Never reconstruct canonical identity\s+or replace the artifact with a model-generated product key/i);
  assert.match(skill, /Gemma may format already-returned\s+identity results but cannot extract, prepare, edit, relax, or classify identity\s+evidence/i);

  const identityAt = skill.indexOf("`shopping_identity_resolve`");
  const riskAt = skill.indexOf("`shopping_risk_features`", identityAt);
  const offerAt = skill.indexOf("`shopping_offer_analyze`", identityAt);
  assert.ok(identityAt >= 0 && riskAt > identityAt && offerAt > identityAt,
    "identity resolution must appear before downstream risk and offer tools");
});

test("panel skill carries a non-circular product-clearance dossier through offer ranking and checkout", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /successful `product_recommendation` dossier is the product-clearance\s+artifact/i);
  assert.match(skill, /as `product_clearance` to `shopping_offer_analyze` and later to\s+`shopping_checkout_preflight`/i);
  assert.match(skill, /Missing, stale, wrong-product, offer-scoped,\s+failed, or model-reconstructed clearance prevents every offer from ranking/i);
  assert.match(skill, /Never use an offer- or checkout-level dossier\s+as product clearance.*non-circular/is);
  assert.match(skill, /same complete product-clearance dossier that selected this exact\s+product before offer ranking/i);
  assert.match(skill, /opaque process-issued `clearance_attestation`/i);
  assert.match(skill, /Preserve it byte-for-byte.*Never invent, edit,\s+repair, decode, summarize/is);
  assert.match(skill, /cryptographically reject a missing, forged, or payload-\s*tampered attestation/i);
  assert.match(skill, /harness restart intentionally expires the attestation/i);
  assert.match(skill, /Canonical identity, official safety, merchant trust, counterfeit risk, and\s+purchase protection tools likewise attach a domain-separated\s+`artifact_attestation`/i);
  assert.match(skill, /Never hand-build a replacement from displayed fields, splice assessments/i);
  assert.match(skill, /reject unsigned, cross-type, payload-tampered, or previous-\s*process artifacts/i);
  assert.match(skill, /Gemma\s+must never create, edit, summarize, normalize, or transport only part/i);
  assert.match(skill, /call `browser_snapshot` and pass only its returned\s+`snapshotId` as `snapshot_id` to `shopping_page_evidence`/i);
  assert.match(skill, /does not accept a model-provided URL\s+or `page_text`/i);
  assert.match(skill, /binds the tab, observed URL, capture time,\s+truncation state, and content digest/i);
  assert.match(skill, /Never claim a seller is\s+absent from a complete manufacturer directory when the snapshot is truncated/i);
  assert.match(skill, /Gemma must not create\s+or alter snapshot IDs, receipt fields, content digests/i);
  assert.match(skill, /Use the same receipt-only boundary for checkout/i);
  assert.match(skill, /pass its `snapshotId` as\s+`snapshot_id` to `shopping_checkout_evidence`/i);
  assert.match(skill, /Never paste, transcribe, or\s+model-generate checkout text, URL, charges, coupon state/i);
  assert.match(skill, /Gemma must not decide\s+applicability, invent artifact identity or timestamps/i);
});

test("panel skill delegates cross-product ranking to the deterministic preference tool", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /separate hard constraints .* from preferences/i);
  assert.match(skill, /only their stated preferences to\s+`shopping_preference_rank`/i);
  assert.match(skill, /Follow its deterministic `decision\.action` and\s+`selected_candidate`/i);
  assert.match(skill, /A missing\s+or unverified value is unknown, not zero, false, or a failed constraint/i);
  assert.match(skill, /keep product choice separate\s+from retailer-offer choice/i);
});

test("panel skill requires bounded source-diverse candidate discovery before product ranking", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /`shopping_candidate_coverage`/);
  assert.match(skill, /exact product category and destination\s+market/i);
  assert.match(skill, /Mark\s+each lane required or give a concrete reason/i);
  assert.match(skill, /Relabeling the same query does not create query diversity/i);
  assert.match(skill, /Search\s+snippets and result cards are leads, not direct candidate evidence/i);
  assert.match(skill, /Multiple domains under one corporate owner do not create ownership\s+diversity/i);
  assert.match(skill, /Sponsored and affiliate placements may reveal a candidate but cannot\s+manufacture independent discovery coverage/i);
  assert.match(skill, /permits only `eligible_candidate_ids` to enter product\s+evidence aggregation and `shopping_preference_rank`/i);
  assert.match(skill, /never proves that every product in the world or market\s+was found/i);
  assert.match(skill, /skipped only when the\s+user supplied one exact product/i);
  assert.match(skill, /Gemma must not\s+decide discovery lanes, declare a search complete, infer sponsorship or\s+ownership/i);
  const coverageAt = skill.indexOf("`shopping_candidate_coverage`");
  const evidenceAt = skill.indexOf("`shopping_product_evidence`", coverageAt);
  const rankAt = skill.indexOf("`shopping_preference_rank`", evidenceAt);
  assert.ok(coverageAt >= 0 && evidenceAt > coverageAt && rankAt > evidenceAt,
    "candidate coverage must precede product evidence and preference ranking");
});

test("panel skill requires provenance aggregation before preference ranking", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /first pass these claims to\s+`shopping_product_evidence`/i);
  assert.match(skill, /Search snippets never verify a product fact/i);
  assert.match(skill, /same domain are not independent corroboration/i);
  assert.match(skill, /review theme is not an objective specification/i);
  assert.match(skill, /Never fabricate `verified` evidence status/i);
  assert.match(skill, /leaving\s+`require_verified_evidence` true/i);

  const evidenceAt = skill.indexOf("`shopping_product_evidence`");
  const rankAt = skill.indexOf("`shopping_preference_rank`", evidenceAt);
  assert.ok(evidenceAt >= 0 && rankAt > evidenceAt,
    "product evidence aggregation must precede preference ranking");
});

test("panel skill separates declared specifications from comparable measured performance", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /`shopping_performance_assess`/);
  assert.match(skill, /declared specification separate from independently measured\s+real-world performance/i);
  assert.match(skill, /`declared:<metric>`.*`performance:<metric>`/is);
  assert.match(skill, /exact protocol ID\/version, the full set of material test\s+conditions/i);
  assert.match(skill, /Do not splice base and premium\s+configurations, regional variants, firmware generations/i);
  assert.match(skill, /verified evidence\s+of no manufacturer, seller, or platform funding relationship/i);
  assert.match(skill, /Multiple pages or runs from one lab count once/i);
  assert.match(skill, /sourced uncertainty bounds\s+that\s+contain the reported point/i);
  assert.match(skill, /current sourced instrument\s+calibration when the metric requires it/i);
  assert.match(skill, /`conflict` means independent results disagree beyond policy; do not average/i);
  assert.match(skill, /Raw objective\s+claims labeled measured performance cannot bypass this artifact/i);
  assert.match(skill, /`required_evidence_role: measured_performance`/);
  assert.match(skill, /Set `performance` applicable in `shopping_decision_dossier` whenever a measured\s+metric affected ranking/i);
  assert.match(skill, /Gemma must not decide protocol comparability, test-condition equivalence,\s+source independence/i);
  const performanceAt = skill.indexOf("`shopping_performance_assess`");
  const evidenceAt = skill.indexOf("`shopping_product_evidence`", performanceAt);
  const rankAt = skill.indexOf("`shopping_preference_rank`", evidenceAt);
  assert.ok(performanceAt >= 0 && evidenceAt > performanceAt && rankAt > evidenceAt,
    "performance assessment must precede product evidence and preference ranking");
});

test("panel skill gates every review-derived metric on scoped integrity evidence", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /`shopping_review_integrity`/);
  assert.match(skill, /search-selected excerpts,\s+top-helpful reviews, or recent reviews is not a representative sample/i);
  assert.match(skill, /Product-family, unknown-scope, and different-variant reviews\s+cannot be spliced/i);
  assert.match(skill, /Treat disclosed incentives separately from organic/i);
  assert.match(skill, /Count\s+syndicated text and repeated reviewers once/i);
  assert.match(skill, /Verified purchase is useful\s+context, not proof/i);
  assert.match(skill, /permits only the returned\s+`eligible_review_ids` to enter `shopping_product_evidence`/i);
  assert.match(skill, /`exclude_reviews` means rerun product evidence and preference ranking without\s+those reviews/i);
  assert.match(skill, /integrity signals, not proof of fake reviews, manipulation,\s+fraud/i);
  assert.match(skill, /Set `review_integrity` applicable in `shopping_decision_dossier` whenever any\s+review-derived metric affected/i);
  assert.match(skill, /Gemma must not infer incentive status, variant scope, sampling\s+representativeness, manipulation, fraud, credibility/i);
  const reviewAt = skill.indexOf("`shopping_review_integrity`");
  const evidenceAt = skill.indexOf("`shopping_product_evidence`", reviewAt);
  const rankAt = skill.indexOf("`shopping_preference_rank`", evidenceAt);
  assert.ok(reviewAt >= 0 && evidenceAt > reviewAt && rankAt > evidenceAt,
    "review integrity must precede review aggregation and preference ranking");
});

test("panel skill delegates ownership arithmetic and uncertainty to deterministic code", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /do not rank on purchase price alone/i);
  assert.match(skill, /Obtain the user's ownership horizon when it could change the result/i);
  assert.match(skill, /add only incremental financing interest and fees, never full loan\s+payments on top of acquisition/i);
  assert.match(skill, /Pass the candidates to `shopping_ownership_cost`/i);
  assert.match(skill, /Leave `allow_expected_value_selection` false unless the user\s+explicitly accepts/i);
  assert.match(skill, /missing included costs\s+are unbounded, never zero/i);
  assert.match(skill, /Total cost\s+does not override identity, counterfeit\/seller risk, stock, or checkout safety/i);
});

test("panel skill requires typed value normalization instead of raw quantity division", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /Never compute unit price as landed price divided by a retailer's raw `quantity`/i);
  assert.match(skill, /`shopping_value_assess` before any product or offer ranking that uses unit\s+value/i);
  assert.match(skill, /Keep mass, volume, serving, dose, use, and load dimensions\s+separate/i);
  assert.match(skill, /pack count times the per-pack net quantity/i);
  assert.match(skill, /require one sourced protocol[\s\S]*exactly comparable conditions/i);
  assert.match(skill, /require verified functional or quality equivalence/i);
  assert.match(skill, /shrinkflation signal, not\s+as fraud or proof of merchant intent/i);
  assert.match(skill, /`shopping_offer_analyze` whenever its\s+objective is `unit_cost`/i);
  assert.match(skill, /Set `value` applicable in `shopping_decision_dossier` whenever normalized unit\s+value/i);
  assert.match(skill, /Gemma must not infer density, yield, serving\s+equivalence, quality equivalence/i);
});

test("panel skill gates ranking on lifecycle and ecosystem resilience", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /`shopping_lifecycle_assess` before preference ranking/i);
  assert.match(skill, /continued operation matters/i);
  assert.match(skill, /“Supported today,”.*cannot satisfy a hard support requirement/is);
  assert.match(skill, /Inventory every required consumable, replacement part, battery, accessory,\s+service, and app/i);
  assert.match(skill, /Discontinued required inputs without verified alternatives are blockers/i);
  assert.match(skill, /what a\s+vendor shutdown would disable/i);
  assert.match(skill, /Marketing words such as “open,” “compatible,” or “future-proof” are\s+not evidence/i);
  assert.match(skill, /follow `purchase_gate`/i);
  assert.match(skill, /do not hide lock-in inside a weighted score/i);
  assert.match(skill, /Only verified dates satisfy hard support commitments/i);
  assert.match(skill, /pass its cost once to `shopping_ownership_cost`/i);
  assert.match(skill, /never chooses among otherwise eligible products/i);
  assert.match(skill, /Gemma must not infer support dates/i);

  const evidenceAt = skill.indexOf("`shopping_product_evidence`");
  const lifecycleAt = skill.indexOf("`shopping_lifecycle_assess`", evidenceAt);
  const rankAt = skill.indexOf("`shopping_preference_rank`", lifecycleAt);
  assert.ok(evidenceAt >= 0 && lifecycleAt > evidenceAt && rankAt > lifecycleAt,
    "lifecycle assessment must follow evidence aggregation and precede preference ranking");
});

test("panel skill delegates deal quality and timing to verified history analysis", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /do not compare the headline price with MSRP alone/i);
  assert.match(skill, /Pass the current exact `offer_id`, product key, and history to\s+`shopping_deal_quality`/i);
  assert.match(skill, /Follow its\s+deterministic `deal_quality`, `sale_claim\.flags`, and `timing\.action`/i);
  assert.match(skill, /automatically prefers its private bounded process-verified price\s+ledger/i);
  assert.match(skill, /Omit `observations`\s+when there is no independently verified external history/i);
  assert.match(skill, /costs no model inference/i);
  assert.match(skill, /stores\s+no page text and strips URL query strings and fragments/i);
  assert.match(skill, /`buy_now` .* does not authorize checkout or purchase/is);
  assert.match(skill, /Never\s+promise that the price will fall/i);
  assert.match(skill, /`avoid_offer` overrides an attractive price/i);
  assert.match(skill, /Pass urgency, target price, and maximum price only when the\s+user stated them/i);
});

test("panel skill requires a scoped fresh dossier before every recommendation", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /`shopping_decision_dossier` before recommending a product/i);
  assert.match(skill, /never substitutes for calling them/i);
  assert.match(skill, /`product_recommendation` always requires verified product evidence/i);
  assert.match(skill, /`offer_recommendation` additionally requires exact identity, merchant trust,\s+counterfeit risk, non-new condition integrity when applicable, purchase\s+protection/i);
  assert.match(skill, /`checkout_review` requires every applicable upstream artifact plus a fresh\s+checkout preflight/i);
  assert.match(skill, /A skipped stage needs a concrete reason/i);
  assert.match(skill, /Never recycle an artifact from another product/i);
  assert.match(skill, /Follow `decision\.action` exactly/i);
  assert.match(skill, /`block` cannot be overridden by model judgment, price, reviews/i);
  assert.match(skill, /`present_checkout_for_confirmation` permits only the final summary/i);
  assert.match(skill, /future-dated, unidentified, stale, or wrong-subject artifacts as invalid/i);
  assert.match(skill, /`purchase_allowed` and `model_override_allowed` remain false/i);
  assert.match(skill, /Gemma must not decide\s+applicability/i);
});

test("panel skill delegates exact-offer purchase protection to deterministic code", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /exact seller, item condition, and offer/i);
  assert.match(skill, /return window does not\s+mean the return is free or easy/i);
  assert.match(skill, /restocking fee,\s+shipping responsibility and cost/i);
  assert.match(skill, /authorization and registration rules/i);
  assert.match(skill, /Missing fees, claim costs, uncovered repair exposure,\s+dates, return country, or other unsupported facts remain unknown/i);
  assert.match(skill, /complete process-attested identity plus each offer's signed\s+`listing_evidence` and applicable `return_policy_evidence`, `warranty_evidence`,\s+`authorization_evidence`, `repairability_evidence`, and\s+`buyer_protection_evidence` to `shopping_protection_assess`/i);
  assert.match(skill, /does not accept model-authored policy objects,\s+seller authorization, repairability, prices, or verified protection fields/i);
  assert.match(skill, /Unknown return or warranty policy inventory blocks clearance/i);
  assert.match(skill, /Stale,\s+tampered, wrong-kind, marker-free, wrong-seller, or identity-mismatched evidence\s+fails closed/i);
  assert.match(skill, /Use Pareto comparison by default/i);
  assert.match(skill, /lexicographic comparison only when the\s+user explicitly supplies/i);
  assert.match(skill, /Protection analysis does not override exact identity/i);
  assert.match(skill, /Pass the complete fresh returned protection artifact to\s+`shopping_offer_analyze` and later to `shopping_checkout_preflight`/i);
  assert.match(skill, /exact offer ID, product, variant, condition, and seller/i);
  assert.match(skill, /Do not recreate deadlines, exposure,\s+warranty eligibility, or status in model prose/i);
  assert.match(skill, /Hermes or OpenClaw model is the main brain/i);
  assert.match(skill, /Gemma may format already-returned protection results but cannot\s+prepare or edit evidence artifacts/i);
  assert.match(skill, /Gemma must not interpret coverage/i);
});

test("panel skill resolves merchant roles and bounds trust claims before offer analysis", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /distinguish the marketplace, displayed seller,\s+legal seller, fulfiller, merchant of record, payment processor, and return\s+recipient/i);
  assert.match(skill, /Marketplace fulfillment, payment processing.*does not prove who legally sells/is);
  assert.match(skill, /merchant terms, privacy,\s+return-policy, and checkout pages/i);
  assert.match(skill, /Pass `listing_evidence` plus the applicable complete signed `terms_evidence`,\s+`privacy_evidence`, `return_policy_evidence`, and `checkout_evidence` to\s+`shopping_merchant_trust` after\s+`shopping_identity_resolve`/i);
  assert.match(skill, /before `shopping_risk_features` or\s+`shopping_offer_analyze`/i);
  assert.match(skill, /does not accept\s+model-authored merchant entities, policy flags, domain claims, recourse, or\s+complaints/i);
  assert.match(skill, /Stale, tampered, wrong-kind, and marker-free evidence fails closed/i);
  assert.match(skill, /Follow each returned `purchase_gate` exactly/i);
  assert.match(skill, /domain age.*at most weak context/is);
  assert.match(skill, /Complaints are allegations, not\s+findings of\s+fraud/i);
  assert.match(skill, /never chooses the product or winning retailer/i);
  assert.match(skill, /Pass the complete fresh returned merchant-trust artifact to\s+`shopping_offer_analyze`/i);
  assert.match(skill, /Before `shopping_checkout_preflight`, refresh merchant\s+trust from the exact current complete checkout snapshot/i);
  assert.match(skill, /checkout must also match the merchant of record and the checkout receipt scope/i);
  assert.match(skill, /low counterfeit-risk result substitute for[\n ]+merchant identity and payment recourse/i);
  assert.match(skill, /Gemma must not infer legal identity/i);
  assert.match(skill, /Gemma may format already-returned merchant results but cannot\s+prepare or edit evidence artifacts/i);

  const identityAt = skill.indexOf("`shopping_identity_resolve`");
  const trustAt = skill.indexOf("`shopping_merchant_trust`", identityAt);
  const riskAt = skill.indexOf("`shopping_risk_features`", trustAt);
  assert.ok(identityAt >= 0 && trustAt > identityAt && riskAt > trustAt,
    "merchant trust must follow identity and precede counterfeit-risk scoring");
});

test("panel skill delegates counterfeit adjudication and accusation authority to deterministic code", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /Call `shopping_counterfeit_assess` with the complete fresh process-attested\s+identity artifact/i);
  assert.match(skill, /complete signed\s+`listing_evidence` plus applicable signed `authorization_evidence` and\s+`warranty_evidence`/i);
  assert.match(skill, /does not accept model-authored seller, authorization,\s+warranty, identifier, packaging, complaint, price, official-finding, or market\s+median fields/i);
  assert.match(skill, /stale, tampered,\s+wrong-kind, or different-seller artifact fails closed/i);
  assert.match(skill, /signed source-specific extractor/i);
  assert.match(skill, /Gemma may format already\s+returned results but cannot prepare, alter, classify, or validate counterfeit\s+evidence/i);
  assert.match(skill, /Follow each returned `purchase_gate` exactly/i);
  assert.match(skill, /price or platform\s+fulfillment cannot fill missing seller\/authenticity evidence/i);
  assert.match(skill, /Use the returned `risk_status` unchanged/i);
  assert.match(skill, /Pass the complete, fresh, exact returned counterfeit artifact to\s+`shopping_offer_analyze`/i);
  assert.match(skill, /missing,\s+stale, scoped to another product\/variant\/seller, identity-mismatched,\s+`unknown`, or `elevated`/i);
  assert.match(skill, /Do not reconstruct or summarize this artifact with a\s+model/i);
  assert.match(skill, /`accusation_allowed` is true only for a\s+verified manufacturer, regulator, court, or accredited-lab finding/i);
  assert.match(skill, /Gray market becomes `acceptable` only when it is disclosed, returnable/i);
  assert.match(skill, /Gemma must\s+not assess authenticity/i);
});

test("panel skill treats non-new condition as exact-offer evidence rather than a seller label", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /seller's condition word or grade is a claim, not proof/i);
  assert.match(skill, /`shopping_condition_assess` for every non-new exact offer/i);
  assert.match(skill, /Set `condition` applicable in `shopping_decision_dossier`/i);
  assert.match(skill, /“Renewed” and “remanufactured” normalize to refurbished/i);
  assert.match(skill, /not comparable\s+across merchants/i);
  assert.match(skill, /require current exact-item photos bound to\s+that unit/i);
  assert.match(skill, /stock or mixed photos cannot verify its defects/i);
  assert.match(skill, /generic “tested” statement cannot silently cover/i);
  assert.match(skill, /activation\/MDM\/carrier lock, unpaid finance\s+balance, lost\/stolen registry hit/i);
  assert.match(skill, /remains `research_more`, not `avoid_offer`/i);
  assert.match(skill, /refusal to buy before\s+verification does not convert an unknown into proof/i);
  assert.match(skill, /verify performer, governing standard, complete work\s+inventory, data-wipe result/i);
  assert.match(skill, /Tradeoff acceptance must come from a fresh current user message/i);
  assert.match(skill, /UI clicks, prior messages, defaults,\s+or agent inference never accept/i);
  assert.match(skill, /Gemma must not infer physical state/i);
});

test("panel skill makes post-purchase persistence and submissions user-controlled", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /`shopping_case_create` only after the user\s+explicitly asks/i);
  assert.match(skill, /Do not silently retain a\s+receipt/i);
  assert.match(skill, /exact immutable user message as `request_id`/i);
  assert.match(skill, /`shopping_page_evidence` using `page_kind: order_receipt`/i);
  assert.match(skill, /pass the complete\s+unchanged signed page artifact to `shopping_case_evidence`/i);
  assert.match(skill, /rejects raw\s+`protection_candidate` objects/i);
  assert.match(skill, /raw `verified: true` records are nonauthoritative/i);
  assert.match(skill, /`shopping_case_event_evidence`/i);
  assert.match(skill, /Never submit raw\s+`event`, `delivered_at`/i);
  assert.match(skill, /private `note` is nonauthoritative/i);
  assert.match(skill, /Legacy events must be\s+refreshed/i);
  assert.match(skill, /Never request, pass, or store a full card number/i);
  assert.match(skill, /Use `shopping_case_list` to show current deadline status/i);
  assert.match(skill, /Listing a due date does not schedule a reminder/i);
  assert.match(skill, /Never claim “I'll remind you” unless a real scheduler/i);
  assert.match(skill, /pass `expected_revision`/i);
  assert.match(skill, /Do\s+not record `return_requested`.*until evidence/is);
  assert.match(skill, /Use `shopping_case_prepare_action`/i);
  assert.match(skill, /`submission_allowed` is always false/i);
  assert.match(skill, /wait for a NEW explicit confirmation/i);
  assert.match(skill, /applies only to that exact submission/i);
  assert.match(skill, /Gemma must not transcribe receipt\s+or policy fields.*infer eligibility/is);
});

test("panel skill separates applied discounts, deferred value, eligibility, and obligations", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /call `shopping_promotion_assess` for\s+the exact product and offer/i);
  assert.match(skill, /convert both with `shopping_page_evidence`/i);
  assert.match(skill, /Never submit raw price, shipping, exact-identity, promotion, applied-\s*status, eligibility, completeness, stacking, acceptance, or obligation fields/i);
  assert.match(skill, /listing badge.*is not proof that a\s+promotion applies/is);
  assert.match(skill, /Only `immediate_checkout_discount_usd`.*may lower the current checkout price/is);
  assert.match(skill, /Keep rebates,\s+cashback, points, store credit, bundle credit, and trade-in value.*deferred_value_usd/is);
  assert.match(skill, /Gift cards are\s+payment tender and financing changes payment timing, not price/i);
  assert.match(skill, /Never infer that the user is a member, student, service member/i);
  assert.match(skill, /only a fresh exact-offer user\s+message can accept it/i);
  assert.match(skill, /Add verified required fees to\s+`guaranteed_economic_cost_usd`/i);
  assert.match(skill, /Pass the exact returned process-attested promotion artifact first to\s+`shopping_fulfillment_assess`, then unchanged to `shopping_offer_analyze`/i);
  assert.match(skill, /Unsigned,\s+edited, stale, wrong-product, wrong-offer, or restarted-process promotion output/i);
  assert.match(skill, /Gemma must not infer eligibility, decide stacking/i);
});

test("panel skill treats stored watches, scheduling, alerts, and purchase as separate authorities", async () => {
  const skill = await fs.readFile(PANEL_SKILL, "utf8");
  assert.match(skill, /Create a watch only when the user explicitly asks/i);
  assert.match(skill, /`shopping_watch_create` stores local watch state;\s+it does not by itself start recurring checks/i);
  assert.match(skill, /Never claim “I'll keep watching” when no\s+scheduler is running/i);
  assert.match(skill, /main brain—not Gemma—must\s+first call `shopping_watch_claim_due`/i);
  assert.match(skill, /If no runs are returned, remain silent/i);
  assert.match(skill, /then call\s+`shopping_watch_evaluate`/i);
  assert.match(skill, /Follow\s+`alert\.should_notify` exactly/i);
  assert.match(skill, /An alert is informational: `purchase_allowed` remains false/i);
  assert.match(skill, /Call `shopping_watch_update` only for an explicit user request/i);
  assert.match(skill, /pass\s+`expected_revision`/i);
  assert.match(skill, /Call `shopping_watch_complete_run` exactly once for every claimed run/i);
  assert.match(skill, /Never reuse an expired lease or complete another\s+worker's run/i);
  assert.match(skill, /Do not open checkout, add to cart, or submit an order during a\s+scheduled watch run/i);
});

// Run hermes-brain against a config file we control (HERMES_BRAIN_CONFIG_FILE),
// pointed at a local mock endpoint. Returns {code, stdout, stderr}.
function runBrain(cfgPath, input, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRAIN], {
      env: { ...process.env, HERMES_BRAIN_CONFIG_FILE: cfgPath, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(input);
    child.stdin.end(); // EOF required — the execFile+input hang this replaces
  });
}

test("hermes-brain executes a bounded parallel evidence batch in one model turn", async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-batch-test-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push(JSON.parse(body));
      const text = requests.length === 1
        ? 'SEARCH_BATCH: [{"lane":"product_evidence","query":"camera x tests"},{"lane":"safety","query":"camera x recalls"}]'
        : '```json\n{"correction_detected":false,"prior_claim":null,"searches":[],"products_found":[],"citations":[],"answer":"Parallel evidence complete."}\n```';
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const cfgPath = await writeConfig(dir, `http://127.0.0.1:${server.address().port}`);
  const fixture = path.join(root, "eval/search/live/captures/extract-2026-08-21T16-02-38-384Z.json");
  const result = await runBrain(cfgPath, "compare camera x", { AB_FIXTURE: fixture, AB_EMIT_ENVELOPE: "1" });
  assert.equal(result.code, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.answer, "Parallel evidence complete.");
  assert.equal(envelope.searches.length, 2);
  assert.deepEqual(envelope.searches.map((item) => item.lanes[0]), ["product_evidence", "safety"]);
  const secondPrompt = JSON.stringify(requests[1]);
  assert.match(secondPrompt, /SEARCH BATCH RESULTS/);
  assert.match(secondPrompt, /LANES: product_evidence/);
  assert.match(secondPrompt, /LANES: safety/);
});

function writeConfig(dir, baseUrl) {
  const cfgPath = path.join(dir, "config.yaml");
  const yaml = [
    "model:",
    "  provider: mock",
    `  base_url: ${baseUrl}`,
    "  api_key: test-key",
    "  default: mock-model",
    "  api_mode: anthropic_messages",
    "",
  ].join("\n");
  return fs.writeFile(cfgPath, yaml).then(() => cfgPath);
}

test("hermes-brain falls back to the Hermes CLI for credential-pool configs", async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-cli-test-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cfgPath = path.join(dir, "config.yaml");
  await fs.writeFile(cfgPath, ["model:", "  provider: xai", "  default: grok-4.6", "  base_url: https://api.x.ai/v1", ""].join("\n"));
  const cliPath = path.join(dir, "hermes-stub.mjs");
  await fs.writeFile(cliPath, "#!/usr/bin/env node\nconst args=process.argv.slice(2); if(!args.includes('--oneshot')||!args.includes('--provider')||!args.includes('--model')) process.exit(9); process.stdout.write('credential-pool relay works');\n");
  await fs.chmod(cliPath, 0o700);
  const previous = process.env.HERMES_BRAIN_CLI;
  process.env.HERMES_BRAIN_CLI = cliPath;
  context.after(() => { if (previous == null) delete process.env.HERMES_BRAIN_CLI; else process.env.HERMES_BRAIN_CLI = previous; });
  const result = await runBrain(cfgPath, "test credential pool relay");
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "credential-pool relay works");
});

// Regression for the real panel failure: the endpoint returned only a
// "thinking" block (budget exhausted), so the brain produced no text. The
// brain must fail LOUDLY with a diagnostic naming the block types — never
// silently post nothing, never hang.
test("hermes-brain: thinking-only response fails loudly with diagnostics", async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-test-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      content: [{ type: "thinking", thinking: "..." }],
      stop_reason: "max_tokens",
    }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  context.after(() => server.close());

  const cfgPath = await writeConfig(dir, `http://127.0.0.1:${server.address().port}`);
  const { code, stdout, stderr } = await runBrain(cfgPath, "what's the cheapest protein powder?");

  assert.equal(code, 1, "brain must exit non-zero on no-text response");
  assert.equal(stdout, "", "brain must not emit an empty reply");
  assert.match(stderr, /model returned no text/);
  assert.match(stderr, /thinking/, "diagnostic must name the block types actually returned");
});

// Happy path against the mock: text block comes back → brain prints it, exit 0.
test("hermes-brain: text block is emitted on stdout with exit 0", async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-test-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        content: [
          { type: "thinking", thinking: "internal" },
          { type: "text", text: "NOW Foods Isolate at $0.044/g protein." },
        ],
      }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  context.after(() => server.close());

  const cfgPath = await writeConfig(dir, `http://127.0.0.1:${server.address().port}`);
  const { code, stdout } = await runBrain(cfgPath, "cheapest protein?");

  assert.equal(code, 0);
  assert.equal(stdout, "NOW Foods Isolate at $0.044/g protein.");
});

// Endpoints that reject the thinking param (400) must trigger the bare retry.
test("hermes-brain: retries without thinking param on 400", async (context) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-test-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));

  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      seen.push(parsed);
      if ("thinking" in parsed) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "thinking not supported" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  context.after(() => server.close());

  const cfgPath = await writeConfig(dir, `http://127.0.0.1:${server.address().port}`);
  const { code, stdout } = await runBrain(cfgPath, "hi");

  assert.equal(code, 0);
  assert.equal(stdout, "ok");
  assert.equal(seen.length, 2, "expected initial request + bare retry");
  assert.ok("thinking" in seen[0], "first request carried thinking");
  assert.ok(!("thinking" in seen[1]), "retry must drop thinking");
});
