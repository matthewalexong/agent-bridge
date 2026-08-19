# Skill: Product extraction & verification (v3-buyer-frame)

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

## Misleading-claim judgment (the buyer's reading)

A buyer scanning the listing reads the headline protein number as what
ONE scoop (or ONE serving as normally taken) delivers. Judge the claim
from the buyer's point of view, not the technical one:

- If reaching the headline protein number requires MORE scoops or MORE
  servings than a buyer would assume (e.g. "60g protein" but the label
  shows 30g per scoop and a serving is 2 scoops), set
  misleading_claim = true — even if the claim is technically true per
  full serving. The buyer is being led to expect more per scoop than
  they get.
- If the headline quantity exceeds what physically fits in the product
  (e.g. title claims more protein grams than the container's net weight),
  that is misleading_claim = true.
- Only set misleading_claim = false when the headline matches what one
  normal serving actually delivers.

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
