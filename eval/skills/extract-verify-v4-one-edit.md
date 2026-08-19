# Skill: Product extraction & verification (v4-one-edit)

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
   container. Never divide by the container's net weight — net weight is
   not protein.
4. If the headline claim does not match what you actually get per scoop,
   set misleading_claim = true and explain the discrepancy. This
   includes claims that are technically true per full serving but require
   2 or more scoops (buyers read the headline as per scoop), and claims
   that exceed the container's net weight.

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
