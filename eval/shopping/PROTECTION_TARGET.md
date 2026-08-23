# Agent Bridge shopping target: purchase protection

This target compares the practical protection a buyer receives before and
after purchase: returns, warranty validity, claim costs, repairability, buyer
protection, downtime, and important deadlines.

## Success contract

The harness must:

1. use the actual policy for the exact seller and offer, not a marketplace or
   manufacturer policy assumed to apply;
2. distinguish return window from return transaction cost;
3. enforce final-sale and opened-item restrictions;
4. calculate restocking, nonrefundable outbound shipping, and buyer-paid return
   shipping as bounded exposure;
5. validate warranty provider, seller authorization, registration conditions,
   duration, parts/labor coverage, deductibles, shipping, and uncovered work;
6. preserve unknown costs instead of assuming free returns or claims;
7. derive repairability only from verified parts, manuals, and replaceable
   critical-component evidence;
8. calculate return, warranty, registration, and buyer-protection deadlines;
9. reject hard-requirement failures and research decision-relevant unknowns;
10. select a protection winner only through Pareto dominance or an explicit
    lexicographic priority order;
11. require the complete fresh exact-offer artifact inside offer ranking and
    checkout, scoped to offer ID, product, variant, condition, and seller;
12. invalidate protection clearance after any scoped item or seller change and
    require reassessment before final confirmation; and
13. keep protection analysis separate from product identity, authenticity,
    price, and checkout authorization.

## Architecture boundary

The active Hermes or OpenClaw main brain obtains policies and explains their
consequences. `shopping_protection_assess` owns eligibility, exposure arithmetic,
warranty validity, deadlines, repairability, dominance, and decision action.
Gemma may transcribe a short verified policy table but cannot interpret legal
coverage, fill missing terms, calculate exposure, or select a winner.
