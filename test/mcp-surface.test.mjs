import assert from "node:assert/strict";
import test from "node:test";
import {
  advertisedDescription,
  compactPanelHydrationResult,
  compactPanelRead,
  compactPanelSnapshot,
  compactPanelStatusResult,
  defaultEvaluatorResultChars,
  MCP_SURFACE_FULL,
  MCP_SURFACE_PANEL,
  PANEL_TOOL_NAMES,
  resolveMcpSurface,
  serializeToolPayload,
  shouldRegisterMcpTool,
  shouldSlimPanelSchema,
  validatePanelPost,
  validatePanelProductClaims,
} from "../mcp/surface.mjs";

test("live MCP surface defaults to panel", () => {
  assert.equal(resolveMcpSurface({}), MCP_SURFACE_PANEL);
  assert.equal(resolveMcpSurface({ AB_MCP_SURFACE: "panel" }), MCP_SURFACE_PANEL);
  assert.equal(resolveMcpSurface({ AB_MCP_SURFACE: "FULL" }), MCP_SURFACE_FULL);
});

test("panel hydration keeps actionable offer facts without returning signed evidence trees", () => {
  const result = compactPanelHydrationResult({
    candidate_offers: {
      candidate_set_id: "cset_1234567890abcdef12345678",
      offers: [{
        candidate_id: "listing_1",
        candidate: { title: "Example 128GB system", url: "https://shop.example/item" },
        listing_evidence: {
          source: { url: "https://shop.example/item", captured_at: "2026-08-25T12:00:00.000Z" },
          facts: {
            price_usd: { status: "explicit", value: 3999.99 },
            stock: { status: "explicit", value: "in_stock" },
            seller: { status: "explicit", value: "Example Shop" },
          },
          source_receipt: { page_text: "x".repeat(20_000) },
          artifact_attestation: `v1.page_evidence.${"a".repeat(64)}`,
        },
      }],
    },
    candidate_offers_ref: { candidate_offers_id: `candidate_offers_${"b".repeat(32)}` },
    ledger: { entries: 1, reused: 0, extracted: 1 },
  }, MCP_SURFACE_PANEL);
  assert.equal(result.candidate_offers_summary[0].price_usd.value, 3999.99);
  assert.equal(result.candidate_offers_summary[0].stock.value, "in_stock");
  assert.equal("candidate_offers" in result, false);
  assert.ok(JSON.stringify(result).length < 2_000);
});

test("panel conversation tools omit accumulated research trails from model responses", () => {
  const state = {
    agent: "Hermes",
    status: { text: "Verifying exact offers" },
    progress: [{ summary: "x".repeat(10_000) }],
    transcript: [{
      id: "panel_1",
      role: "user",
      text: "Find a machine",
      at: "2026-08-25T12:00:00.000Z",
      research: [{ summary: "x".repeat(10_000) }],
    }],
  };
  const compact = compactPanelRead(state, MCP_SURFACE_PANEL);
  assert.equal(compact.transcript[0].text, "Find a machine");
  assert.equal("research" in compact.transcript[0], false);
  assert.equal("progress" in compact, false);
  assert.ok(JSON.stringify(compact).length < 500);
  assert.deepEqual(compactPanelStatusResult({ status: state.status, progress: state.progress }, MCP_SURFACE_PANEL), {
    updated: true,
    status: state.status,
  });
});

test("panel surface keeps hubs and hides analysis/checkout tools", () => {
  assert.equal(shouldRegisterMcpTool("browser_snapshot", MCP_SURFACE_PANEL), true);
  assert.equal(shouldRegisterMcpTool("shopping_evaluator_batch", MCP_SURFACE_PANEL), true);
  assert.equal(shouldRegisterMcpTool("browser_panel_post", MCP_SURFACE_PANEL), true);
  assert.equal(shouldRegisterMcpTool("collect_code", MCP_SURFACE_PANEL), false);
  assert.equal(shouldRegisterMcpTool("debugger_pause", MCP_SURFACE_PANEL), false);
  assert.equal(shouldRegisterMcpTool("shopping_checkout_terms_accept", MCP_SURFACE_PANEL), false);
  assert.equal(shouldRegisterMcpTool("shopping_merchant_trust", MCP_SURFACE_PANEL), false);
  assert.equal(shouldRegisterMcpTool("shopping_profile_remember", MCP_SURFACE_PANEL), false);
  assert.equal(shouldRegisterMcpTool("browser_click", MCP_SURFACE_PANEL), false, "selector compatibility clicks should stay behind browser_act");
  assert.equal(shouldRegisterMcpTool("browser_fill", MCP_SURFACE_PANEL), false, "selector compatibility fills should stay behind browser_act");
  assert.equal(shouldRegisterMcpTool("browser_click", MCP_SURFACE_FULL), true);
  assert.equal(shouldRegisterMcpTool("browser_fill", MCP_SURFACE_FULL), true);
  for (const evaluator of ["shopping_identity_resolve", "shopping_preference_rank", "shopping_product_evidence", "shopping_candidate_coverage", "shopping_offer_analyze"]) {
    assert.equal(shouldRegisterMcpTool(evaluator, MCP_SURFACE_PANEL), false, `${evaluator} should be reachable only through the evaluator batch`);
    assert.equal(shouldRegisterMcpTool(evaluator, MCP_SURFACE_FULL), true);
  }
  assert.equal(shouldRegisterMcpTool("collect_code", MCP_SURFACE_FULL), true);
  assert.ok(PANEL_TOOL_NAMES.length <= 20);
  assert.ok(PANEL_TOOL_NAMES.includes("shopping_evaluator_batch"));
});

test("panel slims fat shopping schemas and descriptions", () => {
  assert.equal(shouldSlimPanelSchema("shopping_decision_dossier", MCP_SURFACE_PANEL), true);
  assert.equal(shouldSlimPanelSchema("shopping_page_evidence", MCP_SURFACE_PANEL), false);
  assert.equal(shouldSlimPanelSchema("shopping_decision_dossier", MCP_SURFACE_FULL), false);
  const long = `${"Deterministically compose an auditable decision. ".repeat(8)}Extra.`;
  const short = advertisedDescription(long, MCP_SURFACE_PANEL);
  assert.ok(short.length < long.length);
  assert.match(short, /Full contract is enforced/);
  assert.equal(advertisedDescription(long, MCP_SURFACE_FULL), long);
  assert.equal(defaultEvaluatorResultChars(MCP_SURFACE_PANEL), 20_000);
  assert.equal(defaultEvaluatorResultChars(MCP_SURFACE_FULL), 120_000);
});

test("product posts without link cards are rejected", () => {
  assert.equal(validatePanelPost({ kind: "question" }), null);
  assert.equal(validatePanelPost({ kind: "none" }), null);
  assert.match(validatePanelPost({ kind: "products" }), /requires candidate_set_id/);
  assert.match(validatePanelPost({ kind: "products", links: [{ url: "https://www.amazon.com/dp/B0EXAMPLE" }] }), /rejects model-authored links/);
  assert.match(validatePanelPost({ kind: "products", source_snapshot_ids: ["snapshot-1"], candidate_set_id: "cset_aaaaaaaaaaaaaaaaaaaaaaaa", candidate_ids: ["listing_bbbbbbbbbbbbbbbb"] }), /rejects source snapshot cards/);
  assert.match(validatePanelPost({ kind: "products", candidate_set_id: "cset_aaaaaaaaaaaaaaaaaaaaaaaa", candidate_ids: ["listing_bbbbbbbbbbbbbbbb"] }), /recommendation_state/);
  assert.match(validatePanelPost({ kind: "products", recommendation_state: "provisional", candidate_set_id: "cset_aaaaaaaaaaaaaaaaaaaaaaaa", candidate_ids: ["listing_bbbbbbbbbbbbbbbb"] }), /requires shopping_phase/);
  assert.equal(validatePanelPost({ kind: "products", shopping_phase: "research_products", recommendation_state: "provisional", candidate_set_id: "cset_aaaaaaaaaaaaaaaaaaaaaaaa", candidate_ids: ["listing_bbbbbbbbbbbbbbbb"] }), null);
  assert.match(validatePanelPost({ kind: "products", shopping_phase: "explore_category", recommendation_state: "provisional", candidate_set_id: "cset_aaaaaaaaaaaaaaaaaaaaaaaa", candidate_ids: ["listing_bbbbbbbbbbbbbbbb"] }), /cannot publish product cards or links/i);
  assert.match(validatePanelPost({ kind: "question", shopping_phase: "define_requirements", links: [{ url: "https://shop.example/product" }] }), /cannot publish product cards or links/i);
  assert.match(validatePanelPost({ kind: "products", recommendation_state: "verified", candidate_set_id: "cset_aaaaaaaaaaaaaaaaaaaaaaaa", candidate_ids: ["listing_bbbbbbbbbbbbbbbb"] }), /recommendation_ref/);
  assert.match(validatePanelPost({ kind: "none", candidate_set_id: "cset_aaaaaaaaaaaaaaaaaaaaaaaa", candidate_ids: ["listing_bbbbbbbbbbbbbbbb"] }), /only valid/);
  assert.match(validatePanelPost({ text: "Apple is the only practical path. $4,999 in stock.", kind: "none", source_snapshot_ids: ["snapshot-1"] }), /Source-only cards cannot publish/i);
});

test("early broad local-AI guidance maps platform ecosystems before narrowing", () => {
  const appleAndDgxOnly = "For 128 GB local AI, the Apple Mac Studio is excellent and NVIDIA DGX Spark is the other strong option. Which matters more?";
  assert.match(validatePanelPost({ text: appleAndDgxOnly, kind: "question", shopping_phase: "explore_category" }), /must cover Apple Silicon.*NVIDIA.*AMD/i);

  const namedButNarrow = "For 128 GB local AI, consider Apple Silicon, NVIDIA DGX Spark/GB10, and AMD Ryzen AI Max+ 395/Strix Halo. Which matters most?";
  assert.match(validatePanelPost({ text: namedButNarrow, kind: "question", shopping_phase: "define_requirements" }), /multiple partner or vendor systems/i);

  const landscape = "The 128 GB local AI landscape has three main lanes: Apple Silicon Mac Studio; NVIDIA DGX Spark/GB10-class hardware sold in multiple OEM and partner systems such as ASUS Ascent GX10; and AMD Ryzen AI Max+ 395/Strix Halo, a multi-vendor family used in many systems that can be cheaper. Which matters most: CUDA compatibility, maximum model size, portability, or price?";
  assert.equal(validatePanelPost({ text: landscape, kind: "question", shopping_phase: "explore_category" }), null);
});

test("tool payloads are compact JSON", () => {
  const pretty = JSON.stringify({ a: 1, b: ["x"] }, null, 2);
  const compact = serializeToolPayload({ a: 1, b: ["x"] });
  assert.equal(compact, '{"a":1,"b":["x"]}');
  assert.ok(compact.length < pretty.length);
});

test("product copy cannot outrun signed price and availability evidence", () => {
  const unknown = [{ title: "Example", price: "$99.00", price_label: "Item price", availability: "Availability unknown" }];
  assert.match(validatePanelProductClaims({ text: "This is in stock for pickup today.", links: unknown, recommendation_state: "provisional" }), /availability.*unknown/i);
  assert.match(validatePanelProductClaims({ text: "The true price is $99.", links: unknown, recommendation_state: "provisional" }), /verified landed total/i);
  assert.match(validatePanelProductClaims({ text: "This is the cheapest and best option.", links: unknown, recommendation_state: "provisional" }), /cannot name a winner/i);
  assert.equal(validatePanelProductClaims({ text: "This is a market map, not a winner.", links: [{ ...unknown[0], availability: "In stock" }], recommendation_state: "provisional" }), null, "a negated ranking claim is explanatory, not recommendation authority");
  assert.equal(validatePanelProductClaims({ text: "ASUS GX10 at Best Buy; availability is verified below.", links: [{ ...unknown[0], availability: "In stock" }], recommendation_state: "provisional" }), null, "the retailer name Best Buy is not a ranking claim");
  assert.match(validatePanelProductClaims({ text: "No other architecture is comparable.", links: unknown, recommendation_state: "verified" }), /market-exclusivity/i);
  assert.match(validatePanelProductClaims({ text: "This is a lead; price and availability still need verification.", links: unknown, recommendation_state: "provisional" }), /in-stock shortlist/i);
  assert.equal(validatePanelProductClaims({ text: "Availability unverified — this is a research lead.", links: unknown, recommendation_state: "provisional", availability_requirement: "allow_unknown" }), null);
  assert.equal(validatePanelProductClaims({ text: "Verified in stock at an $108 landed total.", links: [{ ...unknown[0], availability: "In stock", landed_total: "$108.00" }], recommendation_state: "verified" }), null);

  const localAiMap = [
    { title: "BOSGAME AMD Ryzen AI Max+ 395 128GB", availability: "In stock", price: "$3,599", seller: "BOSGAME" },
    { title: "NIMO AMD Ryzen AI Max+ 395 128GB", availability: "In stock", price: "$4,699", seller: "NIMO" },
    { title: "ASUS Ascent GX10 NVIDIA GB10 128GB", availability: "In stock", price: "$3,999", seller: "Best Buy" },
    { title: "NVIDIA DGX Spark GB10 128GB", availability: "In stock", price: "$5,299", seller: "Best Buy" },
  ];
  const exactAppleCard = { title: "Apple Mac Studio M5 Max, 18-core CPU, 40-core GPU, 128GB unified memory, 1TB storage", url: "https://www.apple.com/shop/buy-mac/mac-studio/m5-max-chip-18-core-cpu-40-core-gpu-128gb-memory-1tb-storage", availability: "Pre-order", price: "$5,399", seller: "Apple" };
  assert.match(validatePanelProductClaims({ text: "Apple was checked, but no offer was verified.", links: localAiMap, recommendation_state: "provisional" }), /must include a signed exact Apple/i);
  assert.match(validatePanelProductClaims({ text: "Apple Mac Studio M5 Max with 128GB and 1TB is currently pre-order, available starting September 22, so it is excluded from these in-stock cards.", links: localAiMap, recommendation_state: "provisional" }), /must include a signed exact Apple/i);
  assert.match(validatePanelProductClaims({ text: "Apple Mac Studio M5 Max with 128GB and 1TB is currently pre-order and excluded from these in-stock cards.", links: [...localAiMap, exactAppleCard], recommendation_state: "provisional", availability_requirement: "allow_unknown" }), /multi-vendor ecosystem/i);
  assert.equal(validatePanelProductClaims({ text: "Apple Mac Studio M5 Max with 128GB and 1TB is currently pre-order, available starting September 22, so it is excluded from these in-stock cards. Many machines share the Ryzen AI Max+ 395/128GB Strix Halo platform; these are representative, not exhaustive. I can dig into lower-cost Strix Halo systems next if you want.", links: [...localAiMap, exactAppleCard], recommendation_state: "provisional", availability_requirement: "allow_unknown" }), null);
});

test("panel snapshots keep the evidence handle without duplicating element metadata", () => {
  const snapshot = {
    snapshotId: "snapshot-1",
    snapshot: '- link "Product" [ref=e1]',
    url: "https://www.google.com/search?q=product",
    text: "Product $20",
    elements: Array.from({ length: 500 }, (_, index) => ({
      ref: `e${index + 1}`,
      selector: `#item-${index}`,
      ...(index === 0 ? { name: "Product", href: "https://shop.example/product" } : {}),
    })),
    evidence_receipt: { snapshot_id: "snapshot-1" },
  };
  const compact = compactPanelSnapshot(snapshot, MCP_SURFACE_PANEL);
  assert.equal(compact.snapshotId, "snapshot-1");
  assert.equal(compact.evidence_receipt.snapshot_id, "snapshot-1");
  assert.equal("elements" in compact, false);
  assert.equal("text" in compact, false);
  assert.deepEqual(compact.links, [{ ref: "e1", name: "Product", href: "https://shop.example/product" }]);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(snapshot).length / 4);
  assert.equal(compactPanelSnapshot(snapshot, MCP_SURFACE_FULL), snapshot);
});
