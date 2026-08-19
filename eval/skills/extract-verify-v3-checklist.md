# Skill: Product extraction & verification (v3-checklist)

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

## Adversarial checklist — run these checks IN ORDER before answering

CHECK 1: What protein quantity does the headline/title/image claim?
CHECK 2: What does the nutrition label say for protein PER SCOOP?
CHECK 3: How many scoops make one serving?
CHECK 4: Does headline protein equal protein-per-scoop?
   - If NO and it equals protein-per-serving (multiple scoops) instead:
     the headline hides the multi-scoop requirement -> misleading_claim = true
CHECK 5: Is the headline protein quantity physically plausible given the
   container's net weight? If it claims more protein than the product
   can contain -> misleading_claim = true
CHECK 6: Only if ALL checks pass is misleading_claim = false.

State the exact discrepancy in "explanation" (claimed X, actually Y per scoop).

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
