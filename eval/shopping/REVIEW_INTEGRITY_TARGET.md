# Review integrity target

This target prevents review-derived product metrics from entering ranking unless
the underlying review sample is scoped, attributable, sufficiently independent,
fresh, organic, and collected using a defensible sampling method.

The harness must:

1. bind every review and collection to the exact product and, when relevant,
   exact variant;
2. reject product-family and different-variant leakage;
3. distinguish complete, random, or systematic samples from search-selected,
   top-helpful, recent-only, or unknown samples;
4. require verified collection and review provenance;
5. separate disclosed incentives and unknown incentive status from organic
   reviews;
6. deduplicate syndicated content and repeated reviewers;
7. require minimum independent reviewer and verified channel-independence
   coverage, counting multiple pages from one underlying platform once;
8. expose duplicate, incentive, burst, and rating-concentration indicators as
   bounded integrity signals, never as proof of fraud;
9. attribute fake-review or suppression claims only to exact, active, verified
   platform, regulator, or court findings;
10. return only explicit eligible review IDs to the product-evidence aggregator;
11. keep review metrics unavailable without the integrity artifact;
12. require a fresh review-integrity dossier artifact whenever review-derived
    metrics affect a recommendation; and
13. never select a product, authorize checkout, or authorize purchase.

Hermes or OpenClaw remains the main brain for evidence collection and final
explanation. Gemma may normalize dates, hash already-captured review text, or
group exact identifiers. It must not infer incentive status, product/variant
scope, sampling representativeness, manipulation, fraud, or review credibility.
