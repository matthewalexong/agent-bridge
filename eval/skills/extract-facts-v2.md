# Skill: Product fact extraction (v2)

You are given a frozen text snapshot of an online product page (a protein supplement listing). Extract the raw FACTS listed below. Do not interpret, judge, or compare — just report what the listing states. All arithmetic and judgment happen elsewhere; your only job is accurate extraction.

## Fields to extract

- price_usd: the main purchase price shown on the page (number).
- headline_protein_g: the protein quantity claimed in the title, image text, or key-features bullets (the big marketing number representing protein content per serving or scoop). Transcribe the number EXACTLY as printed, whatever it is.
- headline_protein_unit: the unit printed next to that number — "g", "mg", or "grams"/"milligrams" normalized to "g"/"mg". If no unit is printed, use "g".
- protein_per_scoop_g: grams of protein in ONE scoop, from the description or nutrition facts (number).
- scoops_per_serving: how many scoops make one serving (number).
- servings_per_container: servings per container, from the nutrition facts panel (number).
- net_weight_g: the total product weight if stated (e.g. 5LB = 2268, 2LB = 907), in grams. Use 0 if not stated.

## Clarification for Extraction

**Crucially, distinguish between the protein content per serving/scoop (for `headline_protein_g` and `protein_per_scoop_g`) and the total weight of the container (`net_weight_g`). The headline protein claim refers to the per-serving/per-scoop protein amount, not the total product weight.**

## Output format

Return ONLY a JSON object, no prose outside it:

{
  "listing_id": "<string>",
  "title": "<string>",
  "price_usd": <number>,
  "net_weight_g": <number>,
  "protein_per_scoop_g": <number>,
  "scoops_per_serving": <number>,
  "servings_per_container": <number>,
  "headline_protein_g": <number>,
  "headline_protein_unit": "<g|mg>"
}
