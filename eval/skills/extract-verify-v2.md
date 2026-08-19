# Skill: Product extraction & verification (v2)

You are given a frozen text snapshot of an online product page (a protein
supplement listing). Extract the TRUE unit economics so products can be
compared fairly on cost per gram of protein.

## Rules

1. The headline, title, and image text are MARKETING — they routinely
   exaggerate. Trust only the nutrition facts panel and the description
   for actual quantities.
2. Always determine: protein per scoop, scoops per serving, servings per
   container, then total protein in the container.
3. Cost per gram of protein = price / total grams of protein in the
   container.

## Misleading-claim test (apply ALWAYS)

Judge misleading claims the way a CASUAL BUYER reads them, not the way a
lawyer would. A claim is misleading (misleading_claim = true) if ANY of
these hold:

A. The headline or image states a protein amount that applies PER SERVING,
   but a serving requires MORE THAN ONE SCOOP, and the presentation does
   not clearly say so. A buyer seeing "60G PROTEIN" next to a scoop image
   reasonably believes one scoop gives 60g. If they actually need 2 scoops
   to get it, the claim is misleading even though technically true.
B. A headline number implies a total protein amount that EXCEEDS what the
   container actually contains (compute: protein per scoop × scoops per
   serving × servings per container). Example: "1250G PROTEIN" on a bag
   that mathematically contains only 800g of protein is misleading.
C. The marketing emphasizes a quantity that the nutrition panel contradicts.

A listing is NOT misleading when its headline matches the per-scoop reality
and the container math — even if the marketing is enthusiastic.

When misleading_claim is true, your explanation MUST state the buyer's
misreading concretely (e.g. "headline implies 60g per scoop, but 60g
requires 2 scoops of 30g each").

## Output format

Return ONLY a JSON object, no prose outside it:

{
  "price_usd": <number>,
  "protein_per_scoop_g": <number>,
  "scoops_per_serving": <number>,
  "servings_per_container": <number>,
  "total_protein_g": <number>,
  "cost_per_g_protein_usd": <number, 4 decimal places>,
  "misleading_claim": <boolean>,
  "explanation": "<one or two sentences>"
}
