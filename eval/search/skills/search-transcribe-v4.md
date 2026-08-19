# Skill: Search-result listing transcription (v5)

You are given a search query and a frozen text snapshot of the search results page (product listings). Transcribe the FACTS of every listing into structured form. Do not interpret, compare, rank, or decide anything — all matching and judgment happen elsewhere; your only job is accurate transcription.

## What to transcribe per listing

For each listing (identified by its letter, e.g. `[A]`), extract:

- id: the listing letter.
- brand: the brand exactly as stated.
- flavor: the flavor text exactly as stated.
- size_raw: The EXACT text of the "Size:" line, copied verbatim, including any parenthetical notes (e.g. "300g (Pack of 4)", "2.5LB", "1KG"). Do not omit, shorten, or reword any part of it. If there is no Size line, use null.
- size_value: The primary numerical value of the package size, exactly as printed (e.g. 2, 2.2, 2000, 1). Do not compute or total anything.
- size_unit: The unit printed next to the size value, exactly as printed: "LB", "KG", "g", "grams", etc. Do NOT convert between units. If no unit is printed, use "g".
- pack_count: If a bundle/multipack note appears in the size text (e.g. "(Pack of N)", "N-pack", "bundle of N"), extract the integer N. If no such note exists, use null. Do NOT multiply sizes by it.
- protein_value: The NUMBER of protein per serving, exactly as printed.
- protein_unit: The unit printed next to it: "g", "MG", "mg", etc. Do NOT convert between units. If none printed, use "g".
- stock: "in stock" or "out of stock", exactly as stated.
- sponsored: true if the listing is marked sponsored, else false.
- price_usd: The price listed for the item in USD, exactly as printed (e.g., 36.99). If no price is visible, use null.

## Rules

- Transcribe every listing in the snapshot, in order.
- Transcribe numbers and text EXACTLY as printed. Never convert units, never combine fields, never infer missing values, never multiply or total sizes.
- size_raw is a verbatim copy of the Size line — accuracy there matters most; treat it like dictation.
- If a field is absent from a listing, use null for numbers and "" for text.
- If a listing prints a multiplier/bundle note (e.g. "(Pack of N)", "N-pack", "bundle of N"), extract N into `pack_count`.
- Price information must be extracted verbatim if present. If no price is visible, use null.
- Titles may omit information that appears in the field lines — always trust the explicit field lines (Size:, Protein per serving:, Stock:, Sponsored:, and Price).

## Output format

Return ONLY a JSON object, no prose outside it:

{
  "listings": [
    {
      "id": "<letter>",
      "brand": "<string>",
      "flavor": "<string>",
      "size_raw": "<verbatim Size line or null>",
      "size_value": <number>,
      "size_unit": "<string>",
      "pack_count": <integer or null>,
      "protein_value": <number>,
      "protein_unit": "<string>",
      "stock": "<in stock|out of stock>",
      "sponsored": <boolean>,
      "price_usd": <number or null>
    }
  ]
}
