import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("MCP server exposes the browser and analysis tool surface", async (context) => {
  const bridgeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-agent-bridge-test-"));
  context.after(() => fs.rm(bridgeDir, { recursive: true, force: true }));
  const testNow = new Date().toISOString();

  const snapshotText = new Map([
    [101, "Brand: Acme\nProduct Line: Camera X\nModel: CX-1\nCurrent Price: $89.00\nShipping: $15.00\nSold by: Camera Store A\nIn stock\nManufacturer warranty: included\n30-day returns\nCondition: new"],
    [102, "Authorized Seller: Camera Store A"],
    [103, "Brand: Acme\nProduct Line: Camera X\nModel: CX-1\nCurrent Price: $98.00\nFREE delivery\nSold by: Camera Store B\nIn stock\nManufacturer warranty: included\n30-day returns\nCondition: new"],
    [104, "Authorized Seller: Camera Store B"],
    [201, "Brand: Acme\nModel: Drive X\nCurrent Price: $99.00\nFREE delivery\nSold by: Authorized Drive Shop\nManufacturer warranty: included\n30-day returns\nCondition: new"],
    [202, "Authorized Seller: Authorized Drive Shop"],
    [203, "Brand: Acme\nModel: Drive X\nCurrent Price: $40.00\nFREE delivery\nSold by: Unknown Marketplace Seller\nManufacturer warranty does not apply\nCondition: new"],
    [204, "Authorized Seller: Different Seller"],
    [301, "Sold by: Camera Store A\nFulfilled by: Camera Logistics\n30-day returns"],
    [302, "Terms and Conditions\nLegal seller: Camera Store A\nMerchant of record: Camera Store A\nPayment method: credit card"],
    [303, "Privacy Policy\nPersonal information we collect"],
    [304, "Return Policy\nReturns accepted within 30 days\nReturn window starts after delivery\nOpened items accepted\nNo restocking fee\nReturn shipping paid by seller\nOriginal shipping refundable\nReturns sent to: Camera Store A Returns"],
    [305, "Order Summary\nMerchant of record: Camera Store A\nPayment method: credit card"],
    [306, "Limited Warranty\nWarranty provider: manufacturer\nWarranty duration: 1 year\nWarranty registration not required"],
    [311, "Sold by: Camera Store B\nFulfilled by: Camera Logistics\n30-day returns"],
    [312, "Terms and Conditions\nLegal seller: Camera Store B\nMerchant of record: Camera Store B\nPayment method: credit card"],
    [313, "Privacy Policy\nPersonal information we collect"],
    [314, "Return Policy\nReturns accepted within 30 days\nReturn window starts after delivery\nOpened items accepted\nNo restocking fee\nReturn shipping paid by seller\nOriginal shipping refundable\nReturns sent to: Camera Store B Returns"],
    [315, "Order Summary\nMerchant of record: Camera Store B\nPayment method: credit card"],
    [316, "Limited Warranty\nWarranty provider: manufacturer\nWarranty duration: 1 year\nWarranty registration not required"],
    [321, "Sold by: Camera Shop\nFulfilled by: Market Hub\n30-day returns"],
    [322, "Terms and Conditions\nLegal seller: Camera Shop LLC\nMerchant of record: Camera Shop LLC\nPayment method: credit card\nChargebacks: available"],
    [323, "Privacy Policy\nPersonal information we collect"],
    [324, "Return Policy\n30-day returns\nReturns sent to: Camera Shop Returns"],
    [325, "Order Summary\nMerchant of record: Camera Shop LLC\nPayment method: credit card"],
    [331, "Sold by: Unknown Shop\n30-day returns"],
    [332, "Terms and Conditions\nLegal seller: Unknown Shop\nMerchant of record: Unknown Shop\nPayment method: wire transfer"],
    [333, "Privacy Policy\nPersonal information we collect"],
    [334, "Return Policy\n30-day returns\nReturns sent to: Unknown Shop Returns"],
    [335, "Order Summary\nMerchant of record: Unknown Shop\nPayment method: wire transfer"],
    [401, "Brand: Acme\nModel: Camera X\nCurrent Price: $100.00\nFREE delivery\nSold by: Example Shop\nCondition: new"],
    [402, "Return Policy\nFinal sale\nOpened items not accepted"],
    [403, "No manufacturer warranty"],
    [411, "Brand: Acme\nModel: Camera X\nCurrent Price: $100.00\nFREE delivery\nSold by: Example Shop\nCondition: new"],
    [412, "Return Policy\nReturns accepted within 30 days\nReturn window starts after delivery\nOpened items accepted\nNo restocking fee\nReturn shipping paid by seller\nOriginal shipping refundable"],
    [413, "Limited Warranty\nWarranty provider: manufacturer\nWarranty duration: 1 year\nWarranty registration not required"],
    [501, "Brand: Acme\nProduct Line: Camera X\nProduct Category: cameras\nModel: CX-1"],
    [701, "Offer ID: B\nProduct Key: camera-x\nSeller: Camera Store B\nMerchant of record: Camera Store B\nQuantity: 1\nUnit Price: $100.00\nStock: in stock\nReturn Policy: 30-day returns\nPayment Method: Visa ending 1234\nShipping Destination: Home ZIP 94107\nSubtotal: $100.00\nShipping: $0.00\nTax: $8.00\nFees: $0.00\nOrder total: $108.00\nArrives: Tuesday"],
    [702, "Offer ID: A\nProduct Key: camera-x\nPurchase Type: subscription\nTerms Version: terms-1\nTerms Inventory: complete\nInitial Charge: $0.00\nRecurring Charge: $20.00\nRecurring Cadence: monthly\nFirst Recurring Charge: 2026-09-22T20:00:00.000Z\nAuto Renews: yes\nMinimum Cycles: 0\nCancellation Method: online\nCancellation Terms: complete\nCancellation Deadline: Before renewal\nCancellation Fee: $0.00\nAdd-on Inventory: complete\nAdd-on: id=warranty; kind=warranty; selected=yes; optional=yes; preselected=yes; amount=$10.00\nTerm Change Inventory: complete\nUrgency Inventory: complete"],
    [703, "Checkout\nOffer ID: A\nProduct Key: camera-x\nSeller: Camera Store A\nItem Price: $89.00\nShipping: $15.00\nTax: $8.00\nImport Duty Treatment: not applicable\nBrokerage Treatment: not applicable\nCarrier Surcharge Treatment: not applicable\nCurrency Conversion Treatment: not applicable\nShips From Country: US\nDestination Country: US\nDestination Eligible: yes\nIncoterm: domestic\nDelivery Earliest: 2026-08-25T00:00:00.000Z\nDelivery Latest: 2026-08-27T00:00:00.000Z\nTracking Available: yes"],
    [704, "Checkout\nOffer ID: B\nProduct Key: camera-x\nSeller: Camera Store B\nItem Price: $98.00\nShipping: $0.00\nTax: $8.00\nImport Duty Treatment: not applicable\nBrokerage Treatment: not applicable\nCarrier Surcharge Treatment: not applicable\nCurrency Conversion Treatment: not applicable\nShips From Country: US\nDestination Country: US\nDestination Eligible: yes\nIncoterm: domestic\nDelivery Earliest: 2026-08-25T00:00:00.000Z\nDelivery Latest: 2026-08-27T00:00:00.000Z\nTracking Available: yes"],
    [705, "Checkout\nOffer ID: B\nProduct Key: camera-x\nSeller: Camera Store B\nItem Price: $98.00\nShipping: $0.00\nTax: $8.00\nImport Duty Treatment: not applicable\nBrokerage Treatment: not applicable\nCarrier Surcharge Treatment: not applicable\nCurrency Conversion Treatment: not applicable\nShips From Country: US\nDestination Country: US\nDestination Eligible: yes\nIncoterm: domestic\nDelivery Earliest: 2026-08-25T00:00:00.000Z\nDelivery Latest: 2026-08-27T00:00:00.000Z\nTracking Available: yes\nPromotion Inventory: complete\nPromotion: id=save10; type=coupon; code=SAVE10; application=applied; amount=$10.00; affects advertised price=yes; eligibility=complete; obligations=none; stacking=verified\nDiscount: -$10.00\nOrder Total: $96.00"],
    [1101, "Order Receipt: complete\nOrder Number: ORDER-MCP-1\nProduct Key: camera-x\nPurchased At: 2026-08-01T12:00:00.000Z\nDelivered At: 2026-08-05T12:00:00.000Z\nCurrency: USD\nItem Price: $100.00\nOrder Shipping: $0.00\nOrder Total: $100.00\nSeller: Example Shop\nMerchant of record: Example Shop"],
    [1102, "Event Evidence: complete\nCase Event: merchant_contacted\nEvent At: 2026-08-06T12:00:00.000Z\nOrder Number: ORDER-MCP-1\nProduct Key: camera-x\nEvent Reference: message-44\nEvent Counterparty: Example Shop"],
    [502, "Brand: Acme\nModel: Drive X"],
    [503, "Brand: Sony\nProduct Line: WH-1000XM5\nModel: WH-1000XM5"],
    [504, "Brand: SONY\nProduct Line: WH 1000XM5\nModel: WH1000XM5\nCondition: new\nSold by: Audio Shop"],
    [505, "Brand: Acme\nModel: Camera X"],
    [601, "CPSC Recall Search\nAuthority: CPSC\nJurisdiction: US\nProduct Category: cameras\nProduct Key: camera-x\nSearch Status: complete\nNo recalls found"],
  ]);
  const snapshotUrl = new Map([[601, "https://www.cpsc.gov/Recalls"]]);
  const mockBridge = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const rpc = JSON.parse(body || "{}");
      const tabId = rpc.params?.tabId;
      const text = snapshotText.get(tabId);
      response.setHeader("content-type", "application/json");
      if (rpc.method === "browser.status") {
        response.statusCode = 503;
        response.end(JSON.stringify({ ok: false, error: { code: "bridge_offline", message: "Offline in status fixture" } }));
        return;
      }
      if (rpc.method === "panel.get") {
        response.end(JSON.stringify({ ok: true, result: { transcript: [
          { id: "panel_request_1", role: "user", text: "Research camera-x.", at: testNow },
          { id: "panel_budget_1", role: "user", text: "Research camera-x. Keep it under $1000.", at: testNow },
          { id: "panel_case_1", role: "user", text: "Please track this purchase for returns and warranty claims.", at: testNow },
        ] } }));
        return;
      }
      if (rpc.method !== "page.snapshot" || !text) {
        response.statusCode = 400;
        response.end(JSON.stringify({ ok: false, error: { code: "unsupported_test_rpc", message: "Unsupported mock bridge request" } }));
        return;
      }
      response.end(JSON.stringify({ ok: true, result: {
        snapshotId: `snapshot-${tabId}`,
        title: `Fixture ${tabId}`,
        url: snapshotUrl.get(tabId) || `https://fixture.example/${tabId}`,
        text,
        truncated: false,
        elements: [],
      } }));
    });
  });
  await new Promise((resolve) => mockBridge.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => mockBridge.close(resolve)));
  await fs.writeFile(path.join(bridgeDir, "runtime.json"), JSON.stringify({
    schemaVersion: 1,
    host: "127.0.0.1",
    port: mockBridge.address().port,
    token: "test-token",
  }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "mcp", "server.mjs")],
    cwd: root,
    env: {
      PATH: process.env.PATH || "",
      CHROME_AGENT_BRIDGE_DIR: bridgeDir,
      AB_MCP_SURFACE: "full",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "chrome-agent-bridge-test", version: "1.0.0" });
  context.after(() => client.close());
  await client.connect(transport);

  async function observedPage(tabId, page_kind, options = {}) {
    const snapshot = await client.callTool({ name: "browser_snapshot", arguments: { tabId } });
    assert.equal(snapshot.isError, undefined, JSON.stringify(snapshot));
    const evidence = await client.callTool({
      name: "shopping_page_evidence",
      arguments: { snapshot_id: snapshot.structuredContent.snapshotId, page_kind, ...options },
    });
    assert.equal(evidence.isError, undefined, JSON.stringify(evidence));
    return evidence.structuredContent;
  }

  async function observedMerchant(base) {
    return {
      listing_evidence: await observedPage(base, "retailer_listing"),
      terms_evidence: await observedPage(base + 1, "merchant_terms"),
      privacy_evidence: await observedPage(base + 2, "merchant_privacy"),
      return_policy_evidence: await observedPage(base + 3, "return_policy"),
      checkout_evidence: await observedPage(base + 4, "checkout"),
    };
  }

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      "analysis_ast_match",
      "analysis_data_flow",
      "analysis_decode_string_array",
      "analysis_deflat_control_flow",
      "analysis_security_scan",
      "ast_transform_apply",
      "ast_transform_chain",
      "ast_transform_preview",
      "binary_decode",
      "binary_detect_format",
      "binary_encode",
      "binary_entropy_analysis",
      "blackbox_add",
      "blackbox_add_common",
      "blackbox_list",
      "breakpoint",
      "browser_act",
      "browser_activate_tab",
      "browser_cdp_attach",
      "browser_cdp_detach",
      "browser_cdp_events",
      "browser_cdp_send",
      "browser_click",
      "browser_close_tab",
      "browser_fill",
      "browser_list_tabs",
      "browser_navigate",
      "browser_network_poll",
      "browser_network_start",
      "browser_network_stop",
      "browser_open_tab",
      "browser_panel_identify",
      "browser_panel_post",
      "browser_panel_read",
      "browser_panel_status",
      "browser_screenshot",
      "browser_snapshot",
      "browser_snapshot_batch",
      "browser_status",
      "browser_watch_events",
      "collect_code",
      "console_get_exceptions",
      "crypto_compare",
      "crypto_test_harness",
      "debugger_capture_hit",
      "debugger_disassemble",
      "debugger_evaluate",
      "debugger_get_paused_state",
      "debugger_lifecycle",
      "debugger_pause",
      "debugger_resume",
      "debugger_run_to_location",
      "debugger_session",
      "debugger_step",
      "debugger_wait_for_paused",
      "detect_crypto",
      "detect_obfuscation",
      "extract_function_tree",
      "get_call_stack",
      "get_object_properties",
      "get_scope_variables_enhanced",
      "grpc_frame_build",
      "grpc_frame_parse",
      "http2_frame_parse",
      "js_deobfuscate_pipeline",
      "js_solve_constraints",
      "network_export_har",
      "network_extract_auth",
      "network_get_response_body",
      "network_get_stats",
      "network_http2_fingerprint",
      "network_intercept",
      "performance_coverage",
      "performance_get_metrics",
      "performance_take_heap_snapshot",
      "performance_trace",
      "profiler_cpu",
      "profiler_heap_sampling",
      "proto_auto_detect",
      "proto_dissect_dns",
      "proto_dissect_http",
      "proto_export_schema",
      "proto_fingerprint",
      "proto_infer_fields",
      "proto_infer_state_machine",
      "proto_visualize_state",
      "protobuf_decode_raw",
      "search_in_scripts",
      "shopping_candidate_coverage",
      "shopping_case_create",
      "shopping_case_event_evidence",
      "shopping_case_evidence",
      "shopping_case_list",
      "shopping_case_prepare_action",
      "shopping_case_update",
      "shopping_checkout_consent_assess",
      "shopping_checkout_evidence",
      "shopping_checkout_pattern_observe",
      "shopping_checkout_preflight",
      "shopping_checkout_terms_accept",
      "shopping_checkout_terms_challenge",
      "shopping_checkout_terms_evidence",
      "shopping_compatibility_assess",
      "shopping_composition_assess",
      "shopping_condition_assess",
      "shopping_confirmation_accept",
      "shopping_confirmation_challenge",
      "shopping_counterfeit_assess",
      "shopping_deal_quality",
      "shopping_decision_dossier",
      "shopping_evaluator_batch",
      "shopping_fulfillment_assess",
      "shopping_identity_resolve",
      "shopping_lifecycle_assess",
      "shopping_merchant_trust",
      "shopping_offer_analyze",
      "shopping_ownership_cost",
      "shopping_page_evidence",
      "shopping_page_evidence_batch",
      "shopping_performance_assess",
      "shopping_preference_rank",
      "shopping_privacy_assess",
      "shopping_product_evidence",
      "shopping_profile_forget",
      "shopping_profile_list",
      "shopping_profile_remember",
      "shopping_profile_resolve",
      "shopping_profile_update",
      "shopping_promotion_assess",
      "shopping_protection_assess",
      "shopping_request_intake",
      "shopping_research_features",
      "shopping_review_integrity",
      "shopping_risk_features",
      "shopping_safety_assess",
      "shopping_value_assess",
      "shopping_watch_claim_due",
      "shopping_watch_complete_run",
      "shopping_watch_create",
      "shopping_watch_evaluate",
      "shopping_watch_list",
      "shopping_watch_update",
      "sourcemap_coverage",
      "sourcemap_diff",
      "sourcemap_discover",
      "sourcemap_fetch_and_parse",
      "sourcemap_lookup",
      "sourcemap_parse_v4",
      "sourcemap_reconstruct_tree",
      "transform_workbench",
      "understand_code",
      "wasm_inspect",
      "wasm_string_extract",
      "watch",
      "webpack_enumerate",
    ],
  );

  const networkStart = tools.find((tool) => tool.name === "browser_network_start");
  assert.equal(networkStart.inputSchema.properties.rawSessionId.type, "string");
  assert.equal(networkStart.inputSchema.properties.urlMode.default, "origin_path");
  assert.deepEqual(networkStart.inputSchema.properties.urlMode.enum, ["origin_path", "full"]);

  const rawAttach = tools.find((tool) => tool.name === "browser_cdp_attach");
  assert.equal(rawAttach.inputSchema.properties.captureEvents.default, true);
  assert.equal(rawAttach.inputSchema.properties.maxBytes.maximum, 64 * 1024 * 1024);

  const pageAct = tools.find((tool) => tool.name === "browser_act");
  assert.deepEqual(pageAct.inputSchema.properties.kind.enum, ["click", "fill", "press", "select"]);
  assert.equal(pageAct.inputSchema.properties.ref.pattern, "^e\\d+$");

  const panelStatus = tools.find((tool) => tool.name === "browser_panel_status");
  assert.equal(panelStatus.inputSchema.properties.summary.maxLength, 300);
  assert.deepEqual(panelStatus.inputSchema.properties.phase.enum, ["plan", "search", "inspect", "verify", "compare", "decision", "working"]);
  assert.equal(panelStatus.inputSchema.properties.evidence.maxItems, 5);
  assert.equal(panelStatus.inputSchema.properties.evidence.items.maxLength, 160);
  assert.equal(panelStatus.inputSchema.properties.next.maxLength, 200);

  const collectCode = tools.find((tool) => tool.name === "collect_code");
  assert.equal(collectCode.inputSchema.required.includes("sessionId"), true);
  assert.equal(collectCode.inputSchema.properties.includeSource.default, true);

  const authExtract = tools.find((tool) => tool.name === "network_extract_auth");
  assert.equal(authExtract.inputSchema.properties.confirmed.default, false);

  const astPreview = tools.find((tool) => tool.name === "ast_transform_preview");
  assert.deepEqual(astPreview.inputSchema.properties.transforms.items.enum, [
    "constant_fold",
    "dead_code_remove",
    "decode_string_array",
    "deflat_control_flow",
    "strip_debugger",
    "unescape_strings",
  ]);

  const shoppingRisk = tools.find((tool) => tool.name === "shopping_risk_features");
  assert.equal(shoppingRisk.inputSchema.properties.offers.maxItems, 100);
  const identityTool = tools.find((tool) => tool.name === "shopping_identity_resolve");
  assert.ok(identityTool.inputSchema.required.includes("target_evidence"));
  assert.equal("target" in identityTool.inputSchema.properties, false);
  assert.equal("required_fields" in identityTool.inputSchema.properties, false);
  assert.equal("flexible_fields" in identityTool.inputSchema.properties, false);
  const identityCandidateProperties = identityTool.inputSchema.properties.candidates.items.properties;
  assert.ok(identityTool.inputSchema.properties.candidates.items.required.includes("listing_evidence"));
  for (const modelClaim of ["brand", "product_line", "model", "generation", "edition", "region", "capacity", "size", "color", "condition", "identifiers"]) {
    assert.equal(modelClaim in identityCandidateProperties, false);
  }
  const safetyTool = tools.find((tool) => tool.name === "shopping_safety_assess");
  for (const rawSafetyField of ["product_category", "required_authorities", "coverage", "notices"]) assert.equal(rawSafetyField in safetyTool.inputSchema.properties, false);
  assert.ok(safetyTool.inputSchema.required.includes("identity"));
  assert.ok(safetyTool.inputSchema.required.includes("coverage_evidence"));
  const safetyCandidateProperties = safetyTool.inputSchema.properties.candidates.items.properties;
  for (const rawCandidateField of ["identity_verified", "product_key", "seller", "model", "identifiers", "certifications", "remediations"]) assert.equal(rawCandidateField in safetyCandidateProperties, false);
  const offerAnalyzeTool = tools.find((tool) => tool.name === "shopping_offer_analyze");
  assert.equal("stock" in offerAnalyzeTool.inputSchema.properties.offers.items.properties, false);
  const fulfillmentTool = tools.find((tool) => tool.name === "shopping_fulfillment_assess");
  assert.ok(fulfillmentTool.inputSchema.required.includes("identity"));
  assert.ok(fulfillmentTool.inputSchema.properties.offers.items.required.includes("listing_evidence"));
  for (const rawField of ["product_id", "exact_identity", "ships_from_country", "destination_eligible", "item_price", "discount", "charges", "incoterm", "customs", "delivery", "returns"]) {
    assert.equal(rawField in fulfillmentTool.inputSchema.properties.offers.items.properties, false);
  }
  const promotionTool = tools.find((tool) => tool.name === "shopping_promotion_assess");
  assert.equal("offer" in promotionTool.inputSchema.properties, false);
  for (const required of ["offer_id", "identity", "listing_evidence", "checkout_evidence"]) assert.ok(promotionTool.inputSchema.required.includes(required));

  const skipped = (reason) => ({ required: false, reason });
  const requestIntakeTool = tools.find((item) => item.name === "shopping_request_intake");
  assert.deepEqual(Object.keys(requestIntakeTool.inputSchema.properties), ["request_id"]);
  const missingRequest = await client.callTool({ name: "shopping_request_intake", arguments: { request_id: "not-a-panel-message" } });
  assert.equal(missingRequest.isError, true);
  assert.match(missingRequest.content[0].text, /shopping_request_not_found/);
  const requestIntake = await client.callTool({ name: "shopping_request_intake", arguments: { request_id: "panel_request_1" } });
  assert.equal(requestIntake.isError, undefined, JSON.stringify(requestIntake));
  const requestReceipt = requestIntake.structuredContent;
  assert.equal(requestReceipt.text, "Research camera-x.");
  const objectiveClause = requestReceipt.clauses[0].clause_id;
  const decisionContext = ({ phase, product_id, offer_id = null, applicability, profile_revision = 0 }) => ({ request_receipt: requestReceipt, profile_state_revision: profile_revision, phase, product_id, offer_id, objective: "Research camera-x.", objective_clause_ids: [objectiveClause], clause_dispositions: [{ clause_id: objectiveClause, role: "objective" }], market_country_code: "US", destination: { country_code: "US" }, constraints: [], applicability });
  const evaluatorBatch = await client.callTool({ name: "shopping_evaluator_batch", arguments: {
    decision_context: decisionContext({ request_id: "request-batch-surface", phase: "product_recommendation", product_id: "camera-x", applicability: {
      candidate_coverage: { required: true, reason: "Discovery was used." },
      performance: skipped("No measured metric affects this fixture."),
      value: skipped("No unit-value objective affects this fixture."),
      condition: skipped("No offer condition is being ranked."),
      promotion: skipped("No promotion affects this fixture."),
      review_integrity: skipped("Reviews do not affect this fixture."),
      composition: skipped("No composition requirement affects this fixture."),
      privacy: skipped("No connected-data feature affects this fixture."),
      compatibility: { required: true, reason: "USB-C is required." },
      lifecycle: skipped("No lifecycle requirement affects this fixture."),
      preferences: skipped("No soft preference affects this fixture."),
      ownership: skipped("No ownership-cost objective affects this fixture."),
      deal: skipped("No timing decision is requested."),
    } }),
    max_concurrency: 2,
    jobs: [
      { job_id: "coverage", tool: "shopping_candidate_coverage", subject: { product_id: "camera-x" }, arguments: { category: "cameras", market_country: "US", evaluated_at: testNow, lanes: [], searches: [], results: [] } },
      { job_id: "compatibility", tool: "shopping_compatibility_assess", subject: { product_id: "camera-x" }, arguments: { category: "device", requirements: [{ id: "connector", kind: "exact", value: "usb-c" }], candidates: [{ id: "camera-x", claims: [{ requirement_id: "connector", kind: "exact", evidence_status: "verified", source_id: "manufacturer-spec", value: "usb-c" }] }] } },
    ],
  } });
  assert.equal(evaluatorBatch.isError, undefined, JSON.stringify(evaluatorBatch));
  assert.deepEqual(evaluatorBatch.structuredContent.results.map((item) => item.status), ["complete", "complete"]);
  assert.deepEqual(evaluatorBatch.structuredContent.dossier_requirements.completed_in_this_wave, ["candidate_coverage", "compatibility"]);
  assert.deepEqual(evaluatorBatch.structuredContent.dossier_requirements.not_in_this_wave, ["product_evidence", "safety"]);
  assert.equal(evaluatorBatch.structuredContent.readiness.recommendation_ready, false);
  assert.equal(evaluatorBatch.structuredContent.readiness.dossier_composition_required, true);

  const budgetIntake = await client.callTool({ name: "shopping_request_intake", arguments: { request_id: "panel_budget_1" } });
  const budgetReceipt = budgetIntake.structuredContent;
  const [budgetObjectiveClause, budgetConstraintClause] = budgetReceipt.clauses;
  const moneyLiteral = budgetConstraintClause.literal_facts.find((item) => item.kind === "money");
  const budgetContext = {
    request_receipt: budgetReceipt, profile_state_revision: 0, phase: "product_recommendation", product_id: "camera-x", offer_id: null,
    objective: "Research camera-x.", objective_clause_ids: [budgetObjectiveClause.clause_id],
    clause_dispositions: [{ clause_id: budgetObjectiveClause.clause_id, role: "objective" }, { clause_id: budgetConstraintClause.clause_id, role: "constraint", constraint_ids: ["budget"] }],
    market_country_code: "US", destination: { country_code: "US" },
    constraints: [{ id: "budget", kind: "budget", requirement: "Maximum price", value: "USD 1000", hard_gate: true, source_clause_ids: [budgetConstraintClause.clause_id], literal_bindings: [moneyLiteral] }],
    applicability: { candidate_coverage: skipped("One exact product."), performance: skipped("No measured metric."), value: skipped("No unit value."), condition: skipped("No offer condition."), promotion: skipped("No promotion."), review_integrity: skipped("No reviews."), composition: skipped("No composition requirement."), privacy: skipped("No privacy requirement."), compatibility: skipped("No compatibility requirement."), lifecycle: skipped("No lifecycle requirement."), preferences: { required: true }, ownership: skipped("No ownership objective."), deal: skipped("No timing request.") },
  };
  const budgetPreferenceArguments = {
    constraints: [{ id: "budget", literal_id: moneyLiteral.literal_id, attribute: "price_usd", operator: "lt", value: 1_000, unit: "USD" }],
    candidate_coverage: { action: "coverage_sufficient", candidate_set_cleared_for_ranking: true, eligible_candidate_ids: ["camera-x"] },
    candidates: [{ id: "camera-x", price_usd: 900, price_evidence_status: "verified" }],
  };
  const constrainedBatch = await client.callTool({ name: "shopping_evaluator_batch", arguments: { decision_context: budgetContext, jobs: [
    { job_id: "budget-preference", tool: "shopping_preference_rank", subject: { product_id: "camera-x" }, constraint_ids: ["budget"], arguments: budgetPreferenceArguments },
  ] } });
  assert.equal(constrainedBatch.structuredContent.results[0].status, "complete", JSON.stringify(constrainedBatch));
  assert.deepEqual(constrainedBatch.structuredContent.results[0].dossier_stage.consumed_constraint_ids, ["budget"]);
  const weakenedBudget = structuredClone(budgetPreferenceArguments);
  weakenedBudget.constraints[0].operator = "lte";
  const rejectedConstraintBatch = await client.callTool({ name: "shopping_evaluator_batch", arguments: { decision_context: budgetContext, jobs: [
    { job_id: "weakened-budget", tool: "shopping_preference_rank", subject: { product_id: "camera-x" }, constraint_ids: ["budget"], arguments: weakenedBudget },
  ] } });
  assert.equal(rejectedConstraintBatch.structuredContent.results[0].status, "failed");
  assert.equal(rejectedConstraintBatch.structuredContent.results[0].error.code, "shopping_constraint_input_mismatch");

  const snapshotBatch = await client.callTool({ name: "browser_snapshot_batch", arguments: { pages: [{ tabId: 101 }, { tabId: 103 }] } });
  assert.equal(snapshotBatch.isError, undefined, JSON.stringify(snapshotBatch));
  assert.deepEqual(snapshotBatch.structuredContent.results.map((item) => item.status), ["complete", "complete"]);
  const [snapshotA, snapshotB] = snapshotBatch.structuredContent.results.map((item) => item.snapshot.snapshotId);
  const evidenceBatch = await client.callTool({ name: "shopping_page_evidence_batch", arguments: { requests: [
    { snapshot_id: snapshotA, page_kind: "retailer_listing" },
    { snapshot_id: snapshotB, page_kind: "retailer_listing" },
    { snapshot_id: snapshotA, page_kind: "retailer_listing" },
    { snapshot_id: snapshotB, page_kind: "retailer_listing" },
  ] } });
  assert.equal(evidenceBatch.isError, undefined, JSON.stringify(evidenceBatch));
  assert.equal(evidenceBatch.structuredContent.artifacts.length, 4);
  assert.deepEqual(evidenceBatch.structuredContent.ledger, { entries: 2, reused: 2, extracted: 2 });
  assert.equal(evidenceBatch.structuredContent.artifacts[0].facts.seller.value, "Camera Store A");
  assert.equal(evidenceBatch.structuredContent.artifacts[1].facts.seller.value, "Camera Store B");

  const rankedTargetEvidence = await observedPage(501, "manufacturer_product");
  const rankedListingA = await observedPage(101, "retailer_listing");
  const rankedListingB = await observedPage(103, "retailer_listing");
  const rankedIdentity = (await client.callTool({
    name: "shopping_identity_resolve",
    arguments: { evaluated_at: testNow, target_product_id: "camera-x", target_evidence: rankedTargetEvidence, candidates: [
      { id: "A", listing_evidence: rankedListingA },
      { id: "B", listing_evidence: rankedListingB },
    ] },
  })).structuredContent;
  const rankedSafetyCoverage = await observedPage(601, "safety_authority_search");
  const rankedSafety = (await client.callTool({
    name: "shopping_safety_assess",
    arguments: { evaluated_at: testNow, jurisdiction: "US", identity: rankedIdentity, coverage_evidence: [{ authority_id: "CPSC", evidence: rankedSafetyCoverage }], candidates: [
      { id: "A", listing_evidence: rankedListingA },
      { id: "B", listing_evidence: rankedListingB },
    ] },
  })).structuredContent;
  const exactProductApplicability = { candidate_coverage: skipped("The user specified this exact camera."), performance: skipped("No measured-performance metric is used in this fixture."), value: skipped("No normalized unit-value metric is used in this fixture."), condition: skipped("This fixture uses verified ordinary new inventory without a condition conflict."), promotion: skipped("No promotion changes price in this fixture."), review_integrity: skipped("No review-derived metric is used in this fixture."), composition: skipped("This camera fixture has no ingredient, allergen, material, or formulation dependency."), privacy: skipped("This bounded camera fixture does not assess connected data processing."), compatibility: skipped("No user-product compatibility dependency in this bounded fixture."), lifecycle: skipped("No lifecycle-sensitive dependency in this bounded fixture."), preferences: skipped("The user specified one exact product."), ownership: skipped("No material ongoing costs."), deal: skipped("Timing was not requested.") };
  const staleProfileBatch = await client.callTool({ name: "shopping_evaluator_batch", arguments: {
    decision_context: decisionContext({ request_id: "request-stale-profile", phase: "product_recommendation", product_id: "camera-x", applicability: exactProductApplicability, profile_revision: 999 }),
    jobs: [{ job_id: "product-evidence", tool: "shopping_product_evidence", subject: { product_id: "camera-x" }, arguments: { policy: { evaluated_at: testNow }, claims: [] } }],
  } });
  assert.equal(staleProfileBatch.isError, true);
  assert.match(staleProfileBatch.content[0].text, /shopping_decision_context_profile_stale/);
  const coreStageBatch = await client.callTool({ name: "shopping_evaluator_batch", arguments: {
    decision_context: decisionContext({ request_id: "request-product-clearance", phase: "product_recommendation", product_id: "camera-x", applicability: exactProductApplicability }), jobs: [
      { job_id: "product-evidence", tool: "shopping_product_evidence", subject: { product_id: "camera-x" }, arguments: { policy: { evaluated_at: testNow }, claims: [{ product_id: "camera-x", attribute: "model", claim_type: "objective", evidence_role: "declared_specification", value: "CX-1", source: { id: "manufacturer-camera-x", source_type: "manufacturer", captured_at: testNow } }] } },
      { job_id: "safety", tool: "shopping_safety_assess", subject: { product_id: "camera-x", offer_id: "A" }, arguments: { evaluated_at: testNow, jurisdiction: "US", identity: rankedIdentity, coverage_evidence: [{ authority_id: "CPSC", evidence: rankedSafetyCoverage }], candidates: [{ id: "A", listing_evidence: rankedListingA }] } },
    ],
  } });
  assert.equal(coreStageBatch.isError, undefined, JSON.stringify(coreStageBatch));
  assert.deepEqual(coreStageBatch.structuredContent.results.map((item) => item.status), ["complete", "complete"]);
  const coreStages = Object.fromEntries(coreStageBatch.structuredContent.results.map((item) => [item.stage, item.dossier_stage]));
  assert.match(coreStages.product_evidence.artifact_attestation, /^v1\.dossier_stage\.[a-f0-9]{64}$/);
  assert.match(coreStages.safety.artifact_attestation, /^v1\.dossier_stage\.[a-f0-9]{64}$/);
  const productClearanceResponse = await client.callTool({ name: "shopping_decision_dossier", arguments: { decision_context: coreStageBatch.structuredContent.decision_context, stages: coreStages } });
  assert.equal(productClearanceResponse.isError, undefined, JSON.stringify(productClearanceResponse));
  const productClearance = productClearanceResponse.structuredContent;
  assert.equal(productClearance.decision.action, "recommend_product");
  assert.match(productClearance.clearance_attestation, /^v1\.[a-f0-9]{64}$/);
  const tamperedStages = structuredClone(coreStages);
  tamperedStages.safety.action = "avoid_product";
  const tamperedDossier = await client.callTool({ name: "shopping_decision_dossier", arguments: { decision_context: coreStageBatch.structuredContent.decision_context, stages: tamperedStages } });
  assert.equal(tamperedDossier.structuredContent.decision.action, "block");
  assert.ok(tamperedDossier.structuredContent.audit.invalid_artifacts.includes("safety"));
  const rankedMerchantA = await observedMerchant(301);
  const rankedMerchantB = await observedMerchant(311);
  const rankedMerchant = (await client.callTool({
    name: "shopping_merchant_trust",
    arguments: { requirements: { reversible_payment_required: true }, evaluated_at: testNow, candidates: [
      { id: "A", product_id: "camera-x", ...rankedMerchantA },
      { id: "B", product_id: "camera-x", ...rankedMerchantB },
    ] },
  })).structuredContent;
  const rankedDirectoryA = await observedPage(102, "manufacturer_authorized_sellers", { seller_query: "Camera Store A", directory_complete: true });
  const rankedDirectoryB = await observedPage(104, "manufacturer_authorized_sellers", { seller_query: "Camera Store B", directory_complete: true });
  const rankedCounterfeit = (await client.callTool({
    name: "shopping_counterfeit_assess",
    arguments: { evaluated_at: testNow, category: "camera", identity: rankedIdentity, offers: [
      { id: "A", listing_evidence: rankedListingA, authorization_evidence: rankedDirectoryA },
      { id: "B", listing_evidence: rankedListingB, authorization_evidence: rankedDirectoryB },
    ] },
  })).structuredContent;
  const rankedWarrantyA = await observedPage(306, "manufacturer_warranty");
  const rankedWarrantyB = await observedPage(316, "manufacturer_warranty");
  const rankedProtection = (await client.callTool({
    name: "shopping_protection_assess",
    arguments: {
      evaluated_at: testNow,
      identity: rankedIdentity,
      candidates: [
        { id: "A", listing_evidence: rankedListingA, return_policy_evidence: rankedMerchantA.return_policy_evidence, warranty_evidence: rankedWarrantyA, authorization_evidence: rankedDirectoryA },
        { id: "B", listing_evidence: rankedListingB, return_policy_evidence: rankedMerchantB.return_policy_evidence, warranty_evidence: rankedWarrantyB, authorization_evidence: rankedDirectoryB },
      ],
    },
  })).structuredContent;
  const rankedCheckoutA = await observedPage(703, "checkout");
  const rankedCheckoutB = await observedPage(704, "checkout");
  const rankedFulfillmentResponse = await client.callTool({
    name: "shopping_fulfillment_assess",
    arguments: {
      evaluated_at: testNow,
      destination_country: "US",
      identity: rankedIdentity,
      offers: [
        { id: "A", listing_evidence: rankedListingA, checkout_evidence: rankedCheckoutA },
        { id: "B", listing_evidence: rankedListingB, checkout_evidence: rankedCheckoutB },
      ],
    },
  });
  assert.equal(rankedFulfillmentResponse.isError, undefined, JSON.stringify(rankedFulfillmentResponse));
  const rankedFulfillment = rankedFulfillmentResponse.structuredContent;
  assert.match(rankedFulfillment.artifact_attestation, /^v1\.fulfillment\./);

  const shoppingDecision = await client.callTool({
    name: "shopping_offer_analyze",
    arguments: {
      evaluated_at: testNow, destination_country: "US",
      requirements: { product_key: "camera-x", condition: "new" },
      offers: [
        { id: "A", product_key: "camera-x", condition: "new", seller: "Camera Store A", quantity: 1, price_usd: 89, shipping_usd: 15, stock: "in_stock" },
        { id: "B", product_key: "camera-x", condition: "new", seller: "Camera Store B", quantity: 1, price_usd: 98, shipping_usd: 0, stock: "in_stock" },
      ],
      fulfillment: rankedFulfillment,
      counterfeit: rankedCounterfeit,
      merchant: rankedMerchant,
      protection: rankedProtection,
      identity: rankedIdentity,
      safety: rankedSafety,
      product_clearance: productClearance,
    },
  });
  assert.equal(shoppingDecision.structuredContent.verified_decision.selected_offer, "B", JSON.stringify(shoppingDecision.structuredContent));
  assert.equal(shoppingDecision.structuredContent.verified_decision.landed_total_usd, 106);

  const shoppingValue = await client.callTool({
    name: "shopping_value_assess",
    arguments: {
      evaluated_at: testNow,
      basis: { id: "filter-count", source: "net_quantity", dimension: "count", unit: "each", conditions_complete: true, conditions: {}, quality_equivalence_required: false },
      offers: [
        { id: "A", product_id: "filter-x", exact_identity: true, captured_at: "2026-08-22T19:59:00.000Z", landed_total: { value: 34, evidence_status: "verified", source_id: "checkout-a" }, package: { pack_count: { value: 1, evidence_status: "verified", source_id: "listing-a" }, net_quantity: { value: 2, unit: "each", evidence_status: "verified", source_id: "listing-a" } } },
        { id: "B", product_id: "filter-x", exact_identity: true, captured_at: "2026-08-22T19:59:00.000Z", landed_total: { value: 48, evidence_status: "verified", source_id: "checkout-b" }, package: { pack_count: { value: 1, evidence_status: "verified", source_id: "listing-b" }, net_quantity: { value: 3, unit: "each", evidence_status: "verified", source_id: "listing-b" } } },
      ],
    },
  });
  assert.equal(shoppingValue.structuredContent.action, "comparable");
  assert.deepEqual(shoppingValue.structuredContent.assessments.map((item) => item.landed_unit_cost_usd), [17, 16]);
  assert.equal(shoppingValue.structuredContent.purchase_allowed, false);

  const shoppingCondition = await client.callTool({
    name: "shopping_condition_assess",
    arguments: {
      evaluated_at: "2026-08-22T20:00:30.000Z",
      requirements: { allowed_conditions: ["open_box"] },
      offer: {
        id: "open-a", product_id: "camera-x", exact_identity: true, represented_condition: "open_box", condition_version: "inspection-1", inspected_at: "2026-08-22T20:00:00.000Z",
        condition_claim: { value: "open_box", evidence_status: "verified", source_id: "listing" }, condition_inventory_complete: true, condition_inventory_evidence_status: "verified", condition_inventory_source_id: "inspection",
        grade: { label: "excellent", scheme_id: "grade-v2", criteria_complete: true, evidence_status: "verified", source_id: "grade-policy" },
        exact_item: { unique_item: false, photo_scope: "stock", evidence_status: "verified", source_id: "batch-program" },
        defects: { inventory_complete: true, evidence_status: "verified", source_id: "inspection", items: [] },
      },
    },
  });
  assert.equal(shoppingCondition.structuredContent.action, "eligible");
  assert.equal(shoppingCondition.structuredContent.condition_cleared_for_offer_comparison, true);
  assert.equal(shoppingCondition.structuredContent.purchase_allowed, false);

  const promotionCheckout = await observedPage(705, "checkout");
  const shoppingPromotion = await client.callTool({
    name: "shopping_promotion_assess",
    arguments: {
      evaluated_at: testNow,
      offer_id: "B",
      identity: rankedIdentity,
      listing_evidence: rankedListingB,
      checkout_evidence: promotionCheckout,
    },
  });
  assert.equal(shoppingPromotion.isError, undefined, JSON.stringify(shoppingPromotion));
  assert.equal(shoppingPromotion.structuredContent.action, "eligible");
  assert.equal(shoppingPromotion.structuredContent.checkout_landed_total_usd, 88);
  assert.match(shoppingPromotion.structuredContent.artifact_attestation, /^v1\.promotion\./);
  assert.equal(shoppingPromotion.structuredContent.purchase_allowed, false);
  const promotedFulfillment = await client.callTool({
    name: "shopping_fulfillment_assess",
    arguments: { evaluated_at: testNow, destination_country: "US", identity: rankedIdentity, offers: [{ id: "B", listing_evidence: rankedListingB, checkout_evidence: promotionCheckout }], promotion_artifacts: [shoppingPromotion.structuredContent] },
  });
  assert.equal(promotedFulfillment.isError, undefined, JSON.stringify(promotedFulfillment));
  assert.equal(promotedFulfillment.structuredContent.assessments[0].fully_landed_total_usd.expected_usd, 96);

  const ownership = await client.callTool({
    name: "shopping_ownership_cost",
    arguments: {
      horizon_months: 36,
      candidates: [
        { id: "cheap", identity_verified: true, acquisition_usd: { expected: 100, evidence_status: "verified" }, cost_components: [{ name: "Required plan", category: "subscription", kind: "recurring", amount_usd: { expected: 10, evidence_status: "verified" }, interval_months: 1 }] },
        { id: "owned", identity_verified: true, acquisition_usd: { expected: 300, evidence_status: "verified" } },
      ],
    },
  });
  assert.equal(ownership.structuredContent.candidates[0].nominal_total.expected_usd, 460);
  assert.equal(ownership.structuredContent.decision.selected_candidate, "owned");

  const lifecycle = await client.callTool({
    name: "shopping_lifecycle_assess",
    arguments: {
      evaluated_at: testNow,
      horizon_months: 36,
      requirements: { security_updates_required: true },
      candidates: [
        { id: "resilient", identity_verified: true, support: { security_updates_until: { date: "2030-08-22T20:00:00.000Z", evidence_status: "verified" } }, ecosystem: { cloud_required: false, vendor_shutdown_effect: "none", interoperability: { standard: "Matter", open_standard: true, evidence_status: "verified" }, data_export: { available: true, formats: ["json"], evidence_status: "verified" }, proprietary_consumables: false, proprietary_connector: false, proprietary_file_format: false, account_transferable: true }, migration: { cost_usd: { expected_usd: 0, evidence_status: "verified" }, path_verified: true }, continuity: [{ name: "Filters", kind: "consumable", required: true, availability: "multiple_sources", compatible_alternatives_verified: true, evidence_status: "verified" }] },
        { id: "stranded", identity_verified: true, support: { security_updates_until: { date: "2030-08-22T20:00:00.000Z", evidence_status: "verified" } }, ecosystem: { cloud_required: false, vendor_shutdown_effect: "none" }, migration: { cost_usd: { expected_usd: 0, evidence_status: "verified" }, path_verified: true }, continuity: [{ name: "Cartridge", kind: "consumable", required: true, availability: "discontinued", compatible_alternatives_verified: false, evidence_status: "verified" }] },
      ],
    },
  });
  assert.deepEqual(lifecycle.structuredContent.decision.eligible_product_ids, ["resilient"]);
  assert.deepEqual(lifecycle.structuredContent.decision.avoid_product_ids, ["stranded"]);
  assert.equal(lifecycle.structuredContent.decision.selects_product, false);

  const safety = await client.callTool({
    name: "shopping_safety_assess",
    arguments: {
      evaluated_at: testNow, jurisdiction: "US",
      identity: rankedIdentity,
      coverage_evidence: [{ authority_id: "CPSC", evidence: rankedSafetyCoverage }],
      candidates: [{ id: "A", listing_evidence: rankedListingA }],
    },
  });
  assert.equal(safety.structuredContent.assessments[0].action, "eligible");
  assert.equal(safety.structuredContent.assessments[0].safety_cleared_for_ranking, true);
  assert.equal(safety.structuredContent.purchase_allowed, false);

  assert.equal(productClearance.decision.action, "recommend_product");
  assert.equal(productClearance.decision.purchase_allowed, false);
  assert.equal(productClearance.decision.model_override_allowed, false);

  const riskFeatures = await client.callTool({
    name: "shopping_risk_features",
    arguments: {
      authorized_market_median_usd: 100,
      offers: [{ id: "A", landed_total_usd: 40, authorized_seller: false, manufacturer_warranty: false, identifier_conflict: true }],
    },
  });
  assert.deepEqual(riskFeatures.structuredContent.risk_features[0].evidence_flags, [
    "unauthorized_seller", "extreme_price_anomaly", "no_manufacturer_warranty", "identifier_conflict",
  ]);

  const counterfeitTarget = await observedPage(502, "manufacturer_product");
  const safeListing = await observedPage(201, "retailer_listing");
  const conflictListing = await observedPage(203, "retailer_listing");
  const counterfeitIdentity = (await client.callTool({
    name: "shopping_identity_resolve",
    arguments: {
      evaluated_at: testNow,
      target_product_id: "drive-x",
      target_evidence: counterfeitTarget,
      candidates: [
        { id: "safe", listing_evidence: safeListing },
        { id: "conflict", listing_evidence: conflictListing },
      ],
    },
  })).structuredContent;
  const safeDirectory = await observedPage(202, "manufacturer_authorized_sellers", { seller_query: "Authorized Drive Shop", directory_complete: true });
  const conflictDirectory = await observedPage(204, "manufacturer_authorized_sellers", { seller_query: "Unknown Marketplace Seller", directory_complete: true });
  const counterfeit = await client.callTool({
    name: "shopping_counterfeit_assess",
    arguments: {
      evaluated_at: testNow,
      category: "storage_media",
      identity: counterfeitIdentity,
      offers: [
        { id: "safe", listing_evidence: safeListing, authorization_evidence: safeDirectory },
        { id: "conflict", listing_evidence: conflictListing, authorization_evidence: conflictDirectory },
      ],
    },
  });
  assert.equal(counterfeit.structuredContent.assessments[0].risk_status, "low");
  assert.equal(counterfeit.structuredContent.assessments[1].risk_status, "unknown");
  assert.equal(counterfeit.structuredContent.assessments[1].accusation_allowed, false);
  assert.deepEqual(counterfeit.structuredContent.decision.eligible_offer_ids, ["safe"]);
  assert.deepEqual(counterfeit.structuredContent.decision.research_offer_ids, ["conflict"]);
  assert.equal(counterfeit.structuredContent.decision.selects_offer, false);

  const pageEvidenceTool = tools.find((candidate) => candidate.name === "shopping_page_evidence");
  assert.ok(pageEvidenceTool.inputSchema.required.includes("snapshot_id"));
  assert.equal("page_text" in pageEvidenceTool.inputSchema.properties, false);
  assert.equal("url" in pageEvidenceTool.inputSchema.properties, false);
  const counterfeitTool = tools.find((candidate) => candidate.name === "shopping_counterfeit_assess");
  assert.ok(counterfeitTool.inputSchema.required.includes("identity"));
  assert.equal("authorized_market_median_usd" in counterfeitTool.inputSchema.properties, false);
  const counterfeitOfferProperties = counterfeitTool.inputSchema.properties.offers.items.properties;
  assert.ok(counterfeitTool.inputSchema.properties.offers.items.required.includes("listing_evidence"));
  for (const modelClaim of ["seller", "authorization", "warranty", "identifiers", "packaging_signals", "complaints", "official_finding", "landed_total_usd", "exact_product"]) {
    assert.equal(modelClaim in counterfeitOfferProperties, false);
  }
  const merchantTool = tools.find((candidate) => candidate.name === "shopping_merchant_trust");
  const merchantOfferProperties = merchantTool.inputSchema.properties.candidates.items.properties;
  assert.ok(merchantTool.inputSchema.properties.candidates.items.required.includes("listing_evidence"));
  for (const modelClaim of ["seller", "legal_seller", "merchant_of_record", "policies", "recourse", "domain", "complaints"]) {
    assert.equal(modelClaim in merchantOfferProperties, false);
  }
  const protectionTool = tools.find((candidate) => candidate.name === "shopping_protection_assess");
  assert.ok(protectionTool.inputSchema.required.includes("identity"));
  const protectionOfferProperties = protectionTool.inputSchema.properties.candidates.items.properties;
  assert.ok(protectionTool.inputSchema.properties.candidates.items.required.includes("listing_evidence"));
  for (const modelClaim of ["seller", "product_id", "returns", "warranty", "repairability", "buyer_protection", "seller_authorized", "landed_total_usd"]) {
    assert.equal(modelClaim in protectionOfferProperties, false);
  }
  const pageEvidence = await client.callTool({
    name: "shopping_page_evidence",
    arguments: { snapshot_id: "snapshot-not-registered" },
  });
  assert.equal(pageEvidence.isError, true);
  assert.match(pageEvidence.content[0].text, /shopping_snapshot_receipt_not_found/);
  const checkoutEvidenceTool = tools.find((candidate) => candidate.name === "shopping_checkout_evidence");
  assert.ok(checkoutEvidenceTool.inputSchema.required.includes("snapshot_id"));
  assert.equal("page_text" in checkoutEvidenceTool.inputSchema.properties, false);
  assert.equal("url" in checkoutEvidenceTool.inputSchema.properties, false);
  const checkoutTermsEvidenceTool = tools.find((candidate) => candidate.name === "shopping_checkout_terms_evidence");
  assert.deepEqual(Object.keys(checkoutTermsEvidenceTool.inputSchema.properties).sort(), ["max_snapshot_age_seconds", "snapshot_id"]);
  assert.equal("page_text" in checkoutTermsEvidenceTool.inputSchema.properties, false);
  const checkoutPreflightTool = tools.find((candidate) => candidate.name === "shopping_checkout_preflight");
  assert.ok(checkoutPreflightTool.inputSchema.required.includes("checkout_evidence"));
  const checkoutConsentTool = tools.find((candidate) => candidate.name === "shopping_checkout_consent_assess");
  assert.equal("acknowledgement" in checkoutConsentTool.inputSchema.properties, false);
  assert.ok("acknowledgement_receipt" in checkoutConsentTool.inputSchema.properties);
  for (const field of ["product_id", "offer_id", "purchase", "add_ons", "term_changes", "urgency_claims", "page_text", "url"]) assert.equal(field in checkoutConsentTool.inputSchema.properties, false);
  assert.ok(checkoutConsentTool.inputSchema.required.includes("terms_evidence"));
  assert.ok(checkoutConsentTool.inputSchema.required.includes("pattern_evidence"));
  const checkoutPatternTool = tools.find((candidate) => candidate.name === "shopping_checkout_pattern_observe");
  assert.deepEqual(Object.keys(checkoutPatternTool.inputSchema.properties), ["terms_evidence"]);
  const termsChallengeTool = tools.find((candidate) => candidate.name === "shopping_checkout_terms_challenge");
  assert.ok(termsChallengeTool.inputSchema.required.includes("terms_evidence"));
  assert.ok(termsChallengeTool.inputSchema.required.includes("pattern_evidence"));
  assert.equal("purchase" in termsChallengeTool.inputSchema.properties, false);
  const termsAcceptTool = tools.find((candidate) => candidate.name === "shopping_checkout_terms_accept");
  assert.deepEqual(Object.keys(termsAcceptTool.inputSchema.properties).sort(), ["challenge", "request_id"]);
  assert.equal("message_text" in termsAcceptTool.inputSchema.properties, false);
  const confirmationChallengeTool = tools.find((candidate) => candidate.name === "shopping_confirmation_challenge");
  assert.deepEqual(confirmationChallengeTool.inputSchema.required.sort(), ["checkout_consent", "checkout_preflight"]);
  const confirmationAcceptTool = tools.find((candidate) => candidate.name === "shopping_confirmation_accept");
  assert.deepEqual(Object.keys(confirmationAcceptTool.inputSchema.properties).sort(), ["challenge", "request_id"]);
  assert.equal("message_text" in confirmationAcceptTool.inputSchema.properties, false);
  const caseEvidenceTool = tools.find((candidate) => candidate.name === "shopping_case_evidence");
  assert.deepEqual(Object.keys(caseEvidenceTool.inputSchema.properties).sort(), ["max_age_seconds", "page_evidence"]);
  const caseCreateTool = tools.find((candidate) => candidate.name === "shopping_case_create");
  assert.ok(caseCreateTool.inputSchema.required.includes("request_id"));
  assert.ok(caseCreateTool.inputSchema.required.includes("protection_evidence"));
  assert.equal("protection_candidate" in caseCreateTool.inputSchema.properties, false);
  assert.equal("user_explicitly_requested_save" in caseCreateTool.inputSchema.properties, false);
  assert.equal(caseCreateTool.inputSchema.properties.evidence.items.properties.verified.const, true);
  const caseEventTool = tools.find((candidate) => candidate.name === "shopping_case_event_evidence");
  assert.deepEqual(Object.keys(caseEventTool.inputSchema.properties).sort(), ["max_age_seconds", "page_evidence"]);
  const caseUpdateTool = tools.find((candidate) => candidate.name === "shopping_case_update");
  assert.equal("event" in caseUpdateTool.inputSchema.properties, false);
  assert.equal("delivered_at" in caseUpdateTool.inputSchema.properties, false);
  assert.ok("event_evidence" in caseUpdateTool.inputSchema.properties);

  const safeMerchantEvidence = await observedMerchant(321);
  const wireMerchantEvidence = await observedMerchant(331);
  const merchantTrust = await client.callTool({
    name: "shopping_merchant_trust",
    arguments: {
      evaluated_at: testNow,
      requirements: { reversible_payment_required: true },
      candidates: [
        { id: "safe", product_id: "camera-x", ...safeMerchantEvidence },
        { id: "wire", product_id: "camera-x", ...wireMerchantEvidence },
      ],
    },
  });
  assert.equal(merchantTrust.structuredContent.assessments[0].role_relationships.seller_is_fulfiller, false);
  assert.deepEqual(merchantTrust.structuredContent.decision.eligible_offer_ids, ["safe"]);
  assert.deepEqual(merchantTrust.structuredContent.decision.avoid_offer_ids, ["wire"]);
  assert.equal(merchantTrust.structuredContent.decision.selects_offer, false);

  const checkoutSnapshot = await client.callTool({ name: "browser_snapshot", arguments: { tabId: 701 } });
  const signedCheckoutEvidence = (await client.callTool({ name: "shopping_checkout_evidence", arguments: { snapshot_id: checkoutSnapshot.structuredContent.snapshotId } })).structuredContent;
  const currentCheckoutPageEvidence = (await client.callTool({ name: "shopping_page_evidence", arguments: { snapshot_id: checkoutSnapshot.structuredContent.snapshotId, page_kind: "checkout" } })).structuredContent;
  const checkoutMerchant = (await client.callTool({
    name: "shopping_merchant_trust",
    arguments: {
      evaluated_at: testNow,
      requirements: { reversible_payment_required: true },
      candidates: [{ id: "B", product_id: "camera-x", ...rankedMerchantB, checkout_evidence: currentCheckoutPageEvidence }],
    },
  })).structuredContent;
  assert.equal(checkoutMerchant.assessments[0].evidence_scope.checkout.source_id, signedCheckoutEvidence.source_receipt.source_id);
  const checkout = await client.callTool({
    name: "shopping_checkout_preflight",
    arguments: {
      expected: { offer_id: "B", destination_country: "US", product_key: "camera-x", quantity: 1, seller: "Camera Store B", evaluated_at: testNow },
      cart: {
        merchant: "Camera Store B", items: [{ id: "B", product_key: "camera-x", quantity: 1, unit_price_usd: 100, seller: "Camera Store B", seller_verified: true, stock: "in_stock", stock_verified: true }],
        discounts: [], subtotal_usd: 100, shipping_usd: 0, tax_usd: 8, fees_usd: 0, reported_total_usd: 108, delivery_estimate: "Tuesday", return_policy: "30-day returns", return_policy_verified: true, payment_method_summary: "Visa ending 1234", shipping_destination_summary: "Home ZIP 94107", captured_at: signedCheckoutEvidence.source.captured_at,
      },
      checkout_evidence: signedCheckoutEvidence,
      counterfeit: rankedCounterfeit,
      merchant: checkoutMerchant,
      protection: rankedProtection,
      identity: rankedIdentity,
      safety: rankedSafety,
      product_clearance: productClearance,
    },
  });
  assert.equal(checkout.structuredContent.status, "ready_for_confirmation");
  assert.equal(checkout.structuredContent.confirmation_required, true);
  assert.equal(checkout.structuredContent.purchase_allowed, false);
  assert.equal(checkout.structuredContent.confirmation_summary.authenticity.risk_status, "low");
  assert.equal(checkout.structuredContent.confirmation_summary.merchant_trust.status, "verified_established");
  assert.equal(checkout.structuredContent.confirmation_summary.purchase_protection.status, "eligible");
  assert.equal(checkout.structuredContent.confirmation_summary.canonical_identity.classification, "exact_match");
  assert.equal(checkout.structuredContent.confirmation_summary.official_safety.action, "eligible");
  assert.equal(checkout.structuredContent.confirmation_summary.product_decision_clearance.dossier_id, productClearance.dossier_id);

  const termsSnapshot = await client.callTool({ name: "browser_snapshot", arguments: { tabId: 702 } });
  const signedTermsEvidence = (await client.callTool({ name: "shopping_checkout_terms_evidence", arguments: { snapshot_id: termsSnapshot.structuredContent.snapshotId } })).structuredContent;
  const signedPatternEvidence = (await client.callTool({ name: "shopping_checkout_pattern_observe", arguments: { terms_evidence: signedTermsEvidence } })).structuredContent;
  assert.equal(signedPatternEvidence.latest_terms_attestation, signedTermsEvidence.artifact_attestation);
  assert.equal(signedPatternEvidence.purchase_allowed, false);
  const termsChallenge = await client.callTool({ name: "shopping_checkout_terms_challenge", arguments: { terms_evidence: signedTermsEvidence, pattern_evidence: signedPatternEvidence } });
  assert.equal(termsChallenge.isError, undefined, JSON.stringify(termsChallenge));
  assert.equal(termsChallenge.structuredContent.product_id, "camera-x");
  assert.equal(termsChallenge.structuredContent.offer_id, "A");
  assert.equal(termsChallenge.structuredContent.purchase_allowed, false);
  const checkoutConsent = await client.callTool({
    name: "shopping_checkout_consent_assess",
    arguments: { terms_evidence: signedTermsEvidence, pattern_evidence: signedPatternEvidence },
  });
  assert.equal(checkoutConsent.structuredContent.status, "remove_unrequested_items");
  assert.deepEqual(checkoutConsent.structuredContent.removals, ["warranty"]);
  assert.equal(checkoutConsent.structuredContent.purchase_allowed, false);

  const deal = await client.callTool({
    name: "shopping_deal_quality",
    arguments: {
      current: { offer_id: "A", product_key: "camera-x", variant: "black", condition: "new", landed_total_usd: 70, landed_price_verified: true, exact_identity: true, stock: "in_stock", risk_status: "low" },
      observations: [100, 95, 90, 85, 80].map((landed_total_usd, index) => ({ product_key: "camera-x", variant: "black", condition: "new", landed_total_usd, verified: true, observed_at: new Date(Date.parse("2026-08-22T20:00:00.000Z") - (5 - index) * 10 * 86_400_000).toISOString(), source: { id: `h${index}`, source_type: "history_provider", url: "https://history.example/item" } })),
      policy: { evaluated_at: "2026-08-22T20:00:00.000Z" },
    },
  });
  assert.equal(deal.structuredContent.deal_quality, "historical_low");
  assert.equal(deal.structuredContent.timing.action, "buy_now");
  assert.equal(deal.structuredContent.timing.future_price_guaranteed, false);

  assert.equal(rankedFulfillment.assessments[1].action, "eligible");
  assert.equal(rankedFulfillment.assessments[1].fully_landed_total_usd.expected_usd, 106);
  assert.equal(rankedFulfillment.assessments[1].purchase_allowed, false);

  const sonyTarget = await observedPage(503, "manufacturer_product");
  const sonyListing = await observedPage(504, "retailer_listing");
  const identityResolution = await client.callTool({
    name: "shopping_identity_resolve",
    arguments: {
      evaluated_at: testNow,
      target_product_id: "sony-wh-1000xm5",
      target_evidence: sonyTarget,
      candidates: [{ id: "A", listing_evidence: sonyListing }],
    },
  });
  assert.equal(identityResolution.structuredContent.resolutions[0].classification, "exact_match");
  assert.equal(identityResolution.structuredContent.resolutions[0].safe_to_compare_offers, true);

  const compatibility = await client.callTool({
    name: "shopping_compatibility_assess",
    arguments: {
      category: "electrical",
      requirements: [{ id: "voltage", kind: "numeric_contained", low: 110, high: 120, unit: "V" }, { id: "plug", kind: "exact", value: "NEMA 5-15" }],
      candidates: [{ id: "A", claims: [{ requirement_id: "voltage", kind: "numeric_contained", low: 100, high: 240, unit: "V", evidence_status: "verified", source_id: "manufacturer-label" }, { requirement_id: "plug", kind: "exact", value: "NEMA 5-15", evidence_status: "verified", source_id: "manufacturer-label" }] }],
    },
  });
  assert.equal(compatibility.structuredContent.assessments[0].action, "compatible");
  assert.equal(compatibility.structuredContent.assessments[0].safe_for_ranking, true);
  assert.equal(compatibility.structuredContent.decision.purchase_allowed, false);

  const composition = await client.callTool({
    name: "shopping_composition_assess",
    arguments: {
      requirements: { excluded_ingredients: [{ name: "retinol" }], allergens: [{ name: "peanut", cross_contact_policy: "avoid" }] },
      candidates: [{ id: "formula-a", identity_verified: true, offer_formulation: { formulation_id: "US-A", region: "US", version: "1" }, label: { formulation_id: "US-A", region: "US", version: "1", ingredient_inventory_complete: true, material_inventory_complete: true, hazard_inventory_complete: true, evidence_status: "verified", source_id: "exact-label" }, ingredients: [{ name: "water", evidence_status: "verified", source_id: "exact-label" }], allergen_statements: [{ allergen: "peanut", status: "free_from", evidence_status: "verified", source_id: "exact-label" }] }],
    },
  });
  assert.equal(composition.structuredContent.assessments[0].action, "eligible");
  assert.equal(composition.structuredContent.assessments[0].medical_diagnosis_provided, false);
  assert.equal(composition.structuredContent.decision.purchase_allowed, false);

  const privacyFact = (value, source_id = "privacy-policy") => ({ value, evidence_status: "verified", source_id });
  const privacy = await client.callTool({
    name: "shopping_privacy_assess",
    arguments: {
      evaluated_at: "2026-08-22T20:00:00.000Z",
      requirements: { prohibit_targeted_ads: true, prohibit_data_sale: true, account_optional_required: true, local_core_operation_required: true, deletion_required: true },
      candidates: [{
        id: "local-camera", identity_verified: true,
        policy: { inventory_complete: true, captured_at: "2026-08-22T19:00:00.000Z", evidence_status: "verified", source_id: "privacy-policy" },
        data_flows: [{ category: "usage", collection: "required", targeted_ads: false, data_sale: false, third_party_sharing: false, retention_days: 30, evidence_status: "verified", source_id: "privacy-policy" }],
        architecture: { account_required: privacyFact(false), cloud_required: privacyFact(false), local_core_operation: privacyFact(true) },
        controls: { account_and_data_deletion: privacyFact(true), deletion_days: { value: 7, evidence_status: "verified", source_id: "privacy-policy" }, data_export: privacyFact(true), consent_withdrawal: privacyFact(true) },
      }],
    },
  });
  assert.equal(privacy.structuredContent.assessments[0].action, "eligible");
  assert.equal(privacy.structuredContent.assessments[0].privacy_cleared_for_ranking, true);
  assert.equal(privacy.structuredContent.decision.purchase_allowed, false);

  const preferenceRanking = await client.callTool({
    name: "shopping_preference_rank",
    arguments: {
      constraints: [{ attribute: "price_usd", operator: "lte", value: 200 }],
      preferences: [{ attribute: "battery_hours", kind: "numeric", direction: "maximize", low: 5, high: 20, weight: 3 }],
      candidate_coverage: { action: "coverage_sufficient", candidate_set_cleared_for_ranking: true, eligible_candidate_ids: ["A", "B"] },
      candidates: [
        { id: "A", price_usd: 150, price_evidence_status: "verified", attributes: { battery_hours: 20 }, attribute_evidence: { battery_hours: "verified" } },
        { id: "B", price_usd: 100, price_evidence_status: "verified", attributes: { battery_hours: 10 }, attribute_evidence: { battery_hours: "verified" } },
      ],
    },
  });
  assert.equal(preferenceRanking.structuredContent.decision.action, "select");
  assert.equal(preferenceRanking.structuredContent.decision.selected_candidate, "A");

  const candidateCoverage = await client.callTool({
    name: "shopping_candidate_coverage",
    arguments: {
      category: "headphones", market_country: "US", evaluated_at: "2026-08-22T20:00:00.000Z", policy: { min_eligible_candidates: 3, min_independent_sources: 3, min_query_families: 2, max_single_owner_share: 0.8 },
      lanes: [{ id: "catalog", kind: "manufacturer_catalog", required: true }, { id: "testing", kind: "independent_testing", required: true }, { id: "retail", kind: "specialist_retailer", required: true }],
      searches: [{ id: "s1", lane_id: "catalog", query_family: "neutral", query_text: "wireless headphones", category: "headphones", market_country: "US", status: "complete", evidence_status: "verified", source_id: "s1-source", searched_at: "2026-08-22T19:00:00.000Z" }, { id: "s2", lane_id: "testing", query_family: "constraint", query_text: "wireless headphones long battery", category: "headphones", market_country: "US", status: "complete", evidence_status: "verified", source_id: "s2-source", searched_at: "2026-08-22T19:00:00.000Z" }, { id: "s3", lane_id: "retail", query_family: "neutral", query_text: "wireless headphones", category: "headphones", market_country: "US", status: "complete", evidence_status: "verified", source_id: "s3-source", searched_at: "2026-08-22T19:00:00.000Z" }],
      results: [{ id: "a1", candidate_id: "A", search_id: "s1", category: "headphones", market_country: "US", identity_status: "exact_candidate", market_status: "available", hard_constraint_status: "eligible", direct_source_verified: true, evidence_status: "verified", source_id: "a1-page", independence_key: "brand-a", ownership_key: "brand-a", placement: "direct_catalog", commercial_relationship: "brand" }, { id: "a2", candidate_id: "A", search_id: "s2", category: "headphones", market_country: "US", identity_status: "exact_candidate", market_status: "available", hard_constraint_status: "eligible", direct_source_verified: true, evidence_status: "verified", source_id: "a2-page", independence_key: "lab", ownership_key: "lab", placement: "organic", commercial_relationship: "none" }, { id: "b", candidate_id: "B", search_id: "s2", category: "headphones", market_country: "US", identity_status: "exact_candidate", market_status: "available", hard_constraint_status: "eligible", direct_source_verified: true, evidence_status: "verified", source_id: "b-page", independence_key: "lab", ownership_key: "lab", placement: "organic", commercial_relationship: "none" }, { id: "c", candidate_id: "C", search_id: "s3", category: "headphones", market_country: "US", identity_status: "exact_candidate", market_status: "available", hard_constraint_status: "eligible", direct_source_verified: true, evidence_status: "verified", source_id: "c-page", independence_key: "store", ownership_key: "store", placement: "direct_catalog", commercial_relationship: "seller" }],
    },
  });
  assert.equal(candidateCoverage.structuredContent.action, "coverage_sufficient");
  assert.deepEqual(candidateCoverage.structuredContent.eligible_candidate_ids, ["A", "B", "C"]);
  assert.equal(candidateCoverage.structuredContent.world_market_exhaustive, false);

  const performanceMeasurement = (id, product_id, lab, value) => ({ id, product_id, variant_id: "us", configuration_id: "standard", firmware_version: "1.2", metric_id: "battery_runtime", value, unit: "min", measured_at: "2026-08-22T19:00:00.000Z", protocol: { id: "video-loop", version: "2", evidence_status: "verified", source_id: "protocol-v2" }, conditions: { brightness_nits: 200, wifi: true }, condition_inventory_complete: true, sample_size: 3, run_coverage_complete: true, uncertainty: { low: value - 5, high: value + 5, evidence_status: "verified", source_id: `uncertainty-${id}` }, evidence_status: "verified", source: { id: `source-${id}`, source_type: "independent_lab", independence_key: lab, funding_relationship: "none", funding_evidence_status: "verified", editorial_independence_verified: true, editorial_independence_evidence_status: "verified" } });
  const performance = await client.callTool({
    name: "shopping_performance_assess",
    arguments: { evaluated_at: "2026-08-22T20:00:00.000Z", metric: { id: "battery_runtime", unit: "min", direction: "higher_better", protocol: { id: "video-loop", version: "2" }, conditions: { brightness_nits: 200, wifi: true }, firmware_sensitive: true }, targets: [{ id: "A", variant_id: "us", configuration_id: "standard", firmware_version: "1.2" }, { id: "B", variant_id: "us", configuration_id: "standard", firmware_version: "1.2" }], measurements: [performanceMeasurement("a1", "A", "lab1", 600), performanceMeasurement("a2", "A", "lab2", 620), performanceMeasurement("b1", "B", "lab1", 500), performanceMeasurement("b2", "B", "lab2", 510)] },
  });
  assert.equal(performance.structuredContent.action, "comparable");
  assert.equal(performance.structuredContent.assessments[0].metric.value, 610);
  assert.equal(performance.structuredContent.purchase_allowed, false);

  const productEvidence = await client.callTool({
    name: "shopping_product_evidence",
    arguments: {
      policy: { evaluated_at: "2026-08-22T20:00:00.000Z" },
      performance_evidence: [performance.structuredContent.assessments[0]],
      claims: [{ product_id: "A", attribute: "declared:battery_hours", claim_type: "objective", evidence_role: "declared_specification", value: 20, unit: "hours", excerpt: "Battery life: 20 hours", source: { id: "manufacturer-spec", source_type: "manufacturer", url: "https://brand.example/spec", captured_at: "2026-08-22T19:00:00.000Z" } }],
    },
  });
  assert.equal(productEvidence.structuredContent.objective_claims[0].status, "verified");
  assert.equal(productEvidence.structuredContent.products[0].verified_attributes["declared:battery_hours"], 1200);
  assert.equal(productEvidence.structuredContent.products[0].verified_attributes["performance:battery_runtime"], 610);
  assert.equal(productEvidence.structuredContent.products[0].attribute_roles["performance:battery_runtime"], "measured_performance");

  const reviewIntegrity = await client.callTool({
    name: "shopping_review_integrity",
    arguments: {
      product_id: "camera-x", evaluated_at: "2026-08-22T20:00:00.000Z", policy: { min_eligible_reviews: 10, min_independent_reviewers: 10, min_channels: 2, max_burst_share: 0.9 },
      collections: ["store-a", "store-b"].map((id) => ({ id, channel_id: id, independence_key: id, product_id: "camera-x", scope_status: "exact_product", sampling_method: "random", population_size: 100, sampled_count: 5, captured_at: "2026-08-22T20:00:00.000Z", evidence_status: "verified", source_id: `source-${id}` })),
      reviews: Array.from({ length: 10 }, (_, index) => ({ id: `review-${index}`, collection_id: index < 5 ? "store-a" : "store-b", product_id: "camera-x", scope_status: "exact_product", source_id: `review-source-${index}`, channel_id: index < 5 ? "store-a" : "store-b", reviewer_key: `reviewer-${index}`, text_fingerprint: `fingerprint-${index}`, evidence_status: "verified", captured_at: "2026-08-22T20:00:00.000Z", published_at: new Date(Date.parse("2026-08-22T20:00:00.000Z") - index * 7 * 86_400_000).toISOString(), moderation_status: "published", incentive_status: "none", verified_purchase: true, rating: (index % 5) + 1 })),
    },
  });
  assert.equal(reviewIntegrity.structuredContent.action, "eligible_for_review_ranking");
  assert.equal(reviewIntegrity.structuredContent.eligible_review_ids.length, 10);
  assert.equal(reviewIntegrity.structuredContent.purchase_allowed, false);

  const profileRemember = await client.callTool({
    name: "shopping_profile_remember",
    arguments: { key: "noise_cancellation", kind: "feature", decision_role: "preference", value: true, scope: { categories: ["headphones"] }, provenance: { source_type: "user_explicit", confirmed_at: "2026-08-22T20:00:00.000Z" }, user_explicitly_requested_memory: true, ttl_days: 365 },
  });
  assert.equal(profileRemember.structuredContent.created, true);
  const profileResolve = await client.callTool({ name: "shopping_profile_resolve", arguments: { evaluated_at: "2026-08-22T20:00:00.000Z", context: { category: "headphones" } } });
  assert.equal(profileResolve.structuredContent.preferences[0].key, "noise_cancellation");
  const profileUpdate = await client.callTool({ name: "shopping_profile_update", arguments: { field_id: profileRemember.structuredContent.field.id, expected_revision: 1, status: "paused", user_explicitly_requested_update: true } });
  assert.equal(profileUpdate.structuredContent.field.status, "paused");
  const profileList = await client.callTool({ name: "shopping_profile_list", arguments: { include_paused: true, evaluated_at: "2026-08-22T20:00:00.000Z" } });
  assert.equal(profileList.structuredContent.fields.length, 1);
  const profileForget = await client.callTool({ name: "shopping_profile_forget", arguments: { field_id: profileRemember.structuredContent.field.id, expected_revision: 2, user_explicitly_requested_forget: true, confirm_permanent_deletion: true } });
  assert.equal(profileForget.structuredContent.deleted, true);
  assert.equal(profileForget.structuredContent.recoverable, false);

  const protectionCandidate = (id, finalSale) => ({ id, product_id: "camera-x", condition: "new", seller: "Example Shop", item_price_usd: 100, price_verified: true, shipping_usd: 0, shipping_verified: true, landed_total_usd: 100, landed_price_verified: true, seller_authorized: true, returns: { policy_verified: true, final_sale: finalSale, window_days: finalSale ? 0 : 30, window_starts_on: "delivery", opened_items: finalSale ? "not_accepted" : "accepted", restocking_fee_percent: 0, return_shipping_paid_by: "seller", original_shipping_refundable: true }, warranty: { policy_verified: true, provider: "manufacturer", duration_months: 12, authorized_seller_required: true, registration_required: false, parts_covered: true, labor_covered: true, deductible_usd: { expected_usd: 0, evidence_status: "verified" }, claim_shipping_paid_by: "provider", estimated_downtime_days_high: 7 }, repairability: { evidence_verified: true, parts_availability: "widely_available", manual_availability: "official", critical_components_replaceable: true }, buyer_protection: { window_days: 120 } });
  const protectionTarget = await observedPage(505, "manufacturer_product");
  const finalListing = await observedPage(401, "retailer_listing");
  const returnableListing = await observedPage(411, "retailer_listing");
  const protectionIdentity = (await client.callTool({
    name: "shopping_identity_resolve",
    arguments: {
      evaluated_at: testNow,
      target_product_id: "camera-x",
      target_evidence: protectionTarget,
      candidates: [
        { id: "final", listing_evidence: finalListing },
        { id: "returnable", listing_evidence: returnableListing },
      ],
    },
  })).structuredContent;
  const finalReturns = await observedPage(402, "return_policy");
  const finalWarranty = await observedPage(403, "manufacturer_warranty");
  const returnableReturns = await observedPage(412, "return_policy");
  const returnableWarranty = await observedPage(413, "manufacturer_warranty");
  const protection = await client.callTool({
    name: "shopping_protection_assess",
    arguments: {
      evaluated_at: testNow,
      identity: protectionIdentity,
      requirements: { returns_required: true },
      candidates: [
        { id: "final", listing_evidence: finalListing, return_policy_evidence: finalReturns, warranty_evidence: finalWarranty },
        { id: "returnable", listing_evidence: returnableListing, return_policy_evidence: returnableReturns, warranty_evidence: returnableWarranty },
      ],
    },
  });
  assert.equal(protection.structuredContent.assessments[0].status, "rejected");
  assert.equal(protection.structuredContent.decision.selected_candidate, "returnable");

  const orderReceiptPage = await observedPage(1101, "order_receipt");
  const signedOrderReceipt = (await client.callTool({ name: "shopping_case_evidence", arguments: { page_evidence: orderReceiptPage } })).structuredContent;
  const returnPolicyPage = await observedPage(412, "return_policy");
  const signedReturnPolicy = (await client.callTool({ name: "shopping_case_evidence", arguments: { page_evidence: returnPolicyPage } })).structuredContent;
  assert.equal(signedOrderReceipt.type, "order_receipt");
  assert.equal(signedOrderReceipt.verified, true);
  const caseCreate = await client.callTool({
    name: "shopping_case_create",
    arguments: {
      label: "Camera X purchase",
      request_id: "panel_case_1",
      merchant: "Example Shop",
      seller: "Example Shop",
      identity: { id: "camera-x", brand: "Acme", product_line: "Camera X", model: "CX-1", condition: "new" },
      offer_id: "returnable",
      order: { order_number: "ORDER-MCP-1", purchased_at: "2026-08-01T12:00:00.000Z", delivered_at: "2026-08-05T12:00:00.000Z", item_price_usd: 100, shipping_usd: 0, total_usd: 100 },
      protection_evidence: protection.structuredContent,
      evidence: [signedOrderReceipt],
    },
  });
  assert.equal(caseCreate.structuredContent.created, true);
  assert.equal(caseCreate.structuredContent.case.timeline.find((item) => item.type === "return_deadline").at, "2026-09-04T12:00:00.000Z");

  const caseUpdate = await client.callTool({ name: "shopping_case_update", arguments: { case_id: caseCreate.structuredContent.case.id, expected_revision: 1, evidence: [signedReturnPolicy] } });
  assert.equal(caseUpdate.structuredContent.case.revision, 2);
  const caseAction = await client.callTool({ name: "shopping_case_prepare_action", arguments: { case_id: caseCreate.structuredContent.case.id, action: "return", problem: "Autofocus fails", requested_resolution: "Refund", evaluated_at: "2026-08-22T20:00:00.000Z" } });
  assert.equal(caseAction.structuredContent.readiness, "ready_for_user_review");
  assert.equal(caseAction.structuredContent.submission_allowed, false);
  const eventPage = await observedPage(1102, "merchant_correspondence");
  const signedEvent = (await client.callTool({ name: "shopping_case_event_evidence", arguments: { page_evidence: eventPage } })).structuredContent;
  const eventUpdate = await client.callTool({ name: "shopping_case_update", arguments: { case_id: caseCreate.structuredContent.case.id, expected_revision: 2, event_evidence: signedEvent } });
  assert.equal(eventUpdate.structuredContent.case.events.at(-1).type, "merchant_contacted");
  const caseList = await client.callTool({ name: "shopping_case_list", arguments: { evaluated_at: "2026-08-22T20:00:00.000Z" } });
  assert.equal(caseList.structuredContent.cases.length, 1);

  const watchCreate = await client.callTool({
    name: "shopping_watch_create",
    arguments: { label: "Camera X", identity: { brand: "Acme", product_line: "Camera X", model: "CX-1", condition: "new" }, required_fields: ["brand", "product_line", "model", "condition"], targets: { target_price_usd: 90 }, sources: ["https://shop.example/camera-x"] },
  });
  assert.equal(watchCreate.structuredContent.created, true);
  assert.equal(watchCreate.structuredContent.watch.status, "active");

  const watchEvaluation = await client.callTool({
    name: "shopping_watch_evaluate",
    arguments: { watch_id: watchCreate.structuredContent.watch.id, candidate_identity: { brand: "Acme", product_line: "Camera X", model: "CX1", condition: "new" }, current: { condition: "new", landed_total_usd: 85, landed_price_verified: true, stock: "in_stock", risk_status: "low", merchant: "Example Shop", offer_url: "https://shop.example/camera-x" }, captured_at: "2026-08-22T20:00:00.000Z", source: { id: "shop-now", source_type: "retailer", url: "https://shop.example/camera-x" } },
  });
  assert.equal(watchEvaluation.structuredContent.alert.should_notify, true);
  assert.equal(watchEvaluation.structuredContent.alert.purchase_allowed, false);

  const watchList = await client.callTool({ name: "shopping_watch_list", arguments: {} });
  assert.equal(watchList.structuredContent.watches.length, 1);

  const watchClaim = await client.callTool({ name: "shopping_watch_claim_due", arguments: { worker_id: "mcp-test" } });
  assert.equal(watchClaim.structuredContent.runs.length, 1);
  const watchComplete = await client.callTool({ name: "shopping_watch_complete_run", arguments: { watch_id: watchCreate.structuredContent.watch.id, run_id: watchClaim.structuredContent.runs[0].run_id, outcome: "success", evaluated_offers: 1, alert_decisions: 1 } });
  assert.equal(watchComplete.structuredContent.watch.lease, null);
  assert.equal(watchComplete.structuredContent.watch.run_state.last_outcome, "success");

  const status = await client.callTool({ name: "browser_status", arguments: {} });
  assert.equal(status.isError, true);
  assert.match(status.content[0].text, /bridge_offline/);

  const authWithoutConfirmation = await client.callTool({
    name: "network_extract_auth",
    arguments: { sessionId: "raw_12345678901234567890" },
  });
  assert.equal(authWithoutConfirmation.isError, true);
  assert.match(authWithoutConfirmation.content[0].text, /confirmation_required/);
});
