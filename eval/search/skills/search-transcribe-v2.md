# Skill: Search-result listing transcription (v2)

You are given a search query and a frozen text snapshot of the search results page (product listings). Transcribe the FACTS of every listing into structured form. Do not interpret, compare, rank, or decide anything — all matching and judgment happen elsewhere; your only job is accurate transcription.

## What to transcribe per listing

For each listing (identified by its letter, e.g. `[A]`), extract:

- id: the listing letter.
- brand: the brand exactly as stated.
- flavor: the flavor text exactly as stated.
- size_value: the NUMBER of the package size, exactly as printed (e.g. 2, 2.2, 2000, 1).
- size_unit: the unit printed next to it, exactly as printed: "LB", "KG", "g", "grams", etc. Do NOT convert between units. If no unit is printed, use "g".
- pack_count: The integer multiplier if a bundle or pack size is indicated (e.g., if it says "(Pack of 5)", transcribe 5). If no pack information is present, use null.
- protein_value: The NUMBER of protein per serving, exactly as printed.
- protein_unit: The unit printed next to it: "g", "MG", "mg", etc. Do NOT convert between units. If none printed, use "g".
- stock: "in stock" or "out of stock", exactly as stated.
- sponsored: true if the listing is marked sponsored, else false.

## Rules

- Transcribe every listing in the snapshot, in order.
- Transcribe numbers EXACTLY as printed. Never convert units, never combine fields, never infer missing values.
- If a field is absent from a listing, use null for numbers and "" for text.
- If a listing prints a multiplier/bundle note (e.g. "(Pack of N)", "N-pack", "bundle of N"), transcribe the PER-UNIT size exactly as printed in `size_value` and report the multiplier as an integer in `pack_count`. Do not multiply or total sizes.
- Titles may omit information that appears in the field lines — always trust the explicit field lines (Size:, Protein per serving:, Stock:, Sponsored:) over the title.

## Output format

Return ONLY a JSON object, no prose outside it:

{
  "listings": [
    {
      "id": "<letter>",
      "brand": "<string>",
      "flavor": "<string>",
      "size_value": <number>,
      "size_unit": "<string>",
      "pack_count": <integer or null>,
      "protein_value": <number>,
      "protein_unit": "<string>",
      "stock": "<in stock|out of stock>",
      "sponsored": <boolean>
    }
  ]
}
