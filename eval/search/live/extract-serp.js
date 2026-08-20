// DOM extraction probe — Step 1 replacement for LLM transcription.
// Injected into a live Amazon SERP by extract-serp.mjs. Returns structured
// listings parsed purely from the DOM. NO model involved.
//
// Selector strategy: primary data-attributes (stable across Amazon A/B
// tests), with class-name fallbacks. Everything is tolerant — a missing
// field becomes null, never a crash.

(() => {
  const txt = (el) => (el ? el.textContent.trim() : null);
  const num = (s) => {
    if (s == null) return null;
    const m = String(s).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  };

  // --- Unit normalization (to ounces) -------------------------------
  const G_PER_OZ = 28.3495;
  function toOz(value, unit) {
    if (value == null || unit == null) return null;
    const u = String(unit).toLowerCase();
    if (u === "oz" || u === "ounce" || u === "ounces") return value;
    if (u === "fl oz" || u === "fl. oz") return value; // fluid oz treated as oz for $/oz checks
    if (u === "lb" || u === "lbs" || u === "pound" || u === "pounds") return value * 16;
    if (u === "g" || u === "gram" || u === "grams") return value / G_PER_OZ;
    if (u === "kg" || u === "kilogram" || u === "kilograms") return (value * 1000) / G_PER_OZ;
    return null;
  }

  // Parse a size string like "5 Pound (Pack of 1)" or "24 Ounce (Pack of 3)".
  function parseSize(raw) {
    if (!raw) return null;
    const m = String(raw).match(/([\d.]+)\s*(pounds?|lbs?|oz|ounces?|fl\s*oz|g|grams?|kg)\b/i);
    if (!m) return null;
    const packM = String(raw).match(/pack\s*of\s*(\d+)/i);
    const pack = packM ? parseInt(packM[1], 10) : 1;
    return buildSize(parseFloat(m[1]), m[2], pack);
  }

  function buildSize(value, unit, pack) {
    const unitOz = toOz(value, unit);
    return {
      perUnit: { value, unit },
      pack,
      totalOz: unitOz == null ? null : unitOz * pack,
    };
  }

  // Fallback: parse package weight out of the TITLE when the size field on the
  // card is missing/unparseable. Titles usually carry an accurate weight, but
  // they ALSO carry per-serving claims ("25g Protein", "5g per scoop").
  // Rule: prefer imperial package units (unambiguous); for metric, keep every
  // g/kg candidate that is NOT followed by claim language, and take the LAST
  // one — package size conventionally sits toward the end of the title.
  // Gram-only products ("Impact Whey, 1000g") parse fine.
  function parseTitleSize(title) {
    if (!title) return null;
    const t = String(title);
    const m1 = t.match(/([\d.]+)\s*(pounds?|lbs?|fl\s*oz|ounces?|oz)\b/i);
    if (m1) return buildSize(parseFloat(m1[1]), m1[2], 1);
    const claimRe = /\b(?:protein|per\s+serving|per\s+scoop)\b/i;
    const candidates = [];
    const re = /([\d.]+)\s*(grams?|g|kg)\b/gi;
    let m;
    while ((m = re.exec(t)) !== null) {
      const after = t.slice(m.index + m[0].length, m.index + m[0].length + 30);
      if (!claimRe.test(after)) candidates.push({ value: parseFloat(m[1]), unit: m[2] });
    }
    if (candidates.length) {
      const pick = candidates[candidates.length - 1];
      return buildSize(pick.value, pick.unit, 1);
    }
    return null;
  }

  // Parse a displayed unit-price string like "$0.67/Ounce" or "$0.67 / oz".
  function parseDisplayedUnitPrice(raw) {
    if (!raw) return null;
    const m = String(raw).match(/\$\s*([\d.]+)\s*\/\s*(ounce|fl\.?\s*oz|oz|pound|lb|count|gram|g|100\s*g|kg)\b/i);
    if (!m) return null;
    return { value: parseFloat(m[1]), unit: m[2].replace(/\s+/g, " ").toLowerCase() };
  }

  const cards = document.querySelectorAll(
    'div[data-component-type="s-search-result"]'
  );

  const listings = [];
  for (const card of cards) {
    const asin = card.getAttribute("data-asin") || null;
    if (!asin) continue; // skip non-product result shells

    // Title
    const titleEl =
      card.querySelector("h2 a span") ||
      card.querySelector("h2 span") ||
      card.querySelector('[data-cy="title-recipe"] h2');
    const title = txt(titleEl);

    // Price: whole + fraction spans ("$72" + ".95")
    let price = null;
    const priceEl = card.querySelector("span.a-price:not(.a-text-price) span.a-offscreen");
    if (priceEl) {
      price = num(txt(priceEl));
    } else {
      const whole = txt(card.querySelector("span.a-price-whole"));
      const frac = txt(card.querySelector("span.a-price-fraction"));
      if (whole != null) price = parseFloat(`${whole.replace(/[^\d]/g, "")}.${(frac || "0").replace(/[^\d]/g, "")}`);
    }

    // Rating + review count. Amazon structure:
    //   <a href="#customerReviews">
    //     <i class="a-icon-star-small"><span class="a-icon-alt">4.2 out of 5 stars</span></i>
    //     <span class="a-size-base ...">(3K)</span>   <- actual review count
    //   </a>
    const ratingEl = card.querySelector('i.a-icon-star-small span.a-icon-alt, i.a-icon-star span.a-icon-alt');
    const ratingText = txt(ratingEl); // e.g. "4.5 out of 5 stars"
    const rating = ratingText ? num(ratingText) : null;

    // Review count: the element after the star icon inside the reviews anchor.
    const reviewsEl =
      card.querySelector('a[href*="#customerReviews"] span:not(.a-icon-alt)') ||
      card.querySelector('div[data-cy="reviews-block"] a span:not(.a-icon-alt)') ||
      card.querySelector('[data-component-type="s-client-side-navigation"] a span:not(.a-icon-alt)');
    const reviewRaw = txt(reviewsEl); // e.g. "(3K)", "973", "1K+"
    // Parse counts like "(3K)" -> 3000, "973" -> 973, "12.4K" -> 12400.
    let reviewCount = null;
    if (reviewRaw) {
      const cleaned = reviewRaw.replace(/[(),]/g, "").trim();
      const km = cleaned.match(/^([\d.]+)\s*[Kk]$/);
      if (km) reviewCount = Math.round(parseFloat(km[1]) * 1000);
      else reviewCount = num(cleaned);
    }

    // Sponsored flag — Amazon marks it in several places across variants
    const sponsored =
      !!card.querySelector('.puis-sponsored-label-text') ||
      !!card.querySelector('a.puis-label-popover-default') ||
      /Sponsored/i.test(txt(card.querySelector('[data-component-type="sp-sponsored-result"]'))) ||
      [...card.querySelectorAll("span")].slice(0, 40).some(
        (s) => txt(s) === "Sponsored"
      );

    // Size / variant line ("4 Pound (Pack of 1)")
    const sizeEl =
      card.querySelector('div[data-cy="size-recipe"] span') ||
      card.querySelector(".a-size-base.a-color-secondary");
    let sizeRaw = null;
    for (const cand of card.querySelectorAll("span, h4, div")) {
      const t = txt(cand);
      if (t && /^\d[\d.]*\s*(LB|LBS|Pound|Pounds|oz|Ounce|Ounces|g|kg)\b/i.test(t) && t.length < 40) {
        sizeRaw = t;
        break;
      }
    }
    if (!sizeRaw && sizeEl) sizeRaw = txt(sizeEl);

    // Stock ("Currently unavailable")
    const availEl = card.querySelector(".a-color-price, .a-size-medium.a-color-secondary");
    const stock = availEl && /unavailable/i.test(txt(availEl)) ? "out of stock" : "in stock";

    // --- Derived-unit-price verification (never trust Amazon's math) ---
    // 1. Capture the unit price Amazon DISPLAYS, if present.
    let displayedUnitPrice = null;
    for (const el of card.querySelectorAll("span, .a-text-price, .a-color-secondary")) {
      const t = txt(el);
      if (t && /\$\s*[\d.]+\s*\/\s*(ounce|fl\.?\s*oz|oz|pound|lb|count|gram|g|kg)\b/i.test(t) && t.length < 60) {
        displayedUnitPrice = { raw: t, ...parseDisplayedUnitPrice(t) };
        break;
      }
    }

    // 2. Independently compute $/oz from raw inputs (price, parsed size).
    // Prefer the explicit size field; fall back to the title's weight.
    let size = parseSize(sizeRaw);
    let sizeSource = size ? "field" : null;
    if (!size) {
      size = parseTitleSize(title);
      if (size) sizeSource = "title";
    }
    let computedPerOz = null;
    if (price != null && size && size.totalOz > 0) {
      computedPerOz = price / size.totalOz;
    }

    // 3. Compare displayed vs computed; flag discrepancy > 2%.
    let unitPriceVerified = null; // null = not verifiable on this page
    if (displayedUnitPrice && computedPerOz != null && displayedUnitPrice.unit &&
        /ounce|fl\.?\s*oz|^oz$/.test(displayedUnitPrice.unit)) {
      const delta = Math.abs(displayedUnitPrice.value - computedPerOz) / computedPerOz;
      unitPriceVerified = {
        displayed: displayedUnitPrice.value,
        computed: Math.round(computedPerOz * 1000) / 1000,
        matches: delta <= 0.02,
        delta_pct: Math.round(delta * 1000) / 10,
        verdict: delta <= 0.02 ? "verified" : "DISCREPANCY — Amazon's displayed unit price is wrong",
      };
    }

    listings.push({
      id: listings.length + 1,
      asin,
      title,
      price_usd: price,
      rating,
      review_count_raw: reviewRaw,
      review_count: reviewCount,
      sponsored,
      size_raw: sizeRaw,
      size_parsed: size ? { value: size.perUnit.value, unit: size.perUnit.unit, pack: size.pack, total_oz: Math.round(size.totalOz * 10) / 10, source: sizeSource } : null,
      computed_per_oz: computedPerOz != null ? Math.round(computedPerOz * 1000) / 1000 : null,
      displayed_unit_price: displayedUnitPrice,
      unit_price_check: unitPriceVerified,
      stock,
    });
  }

  return {
    url: location.href,
    resultCount: listings.length,
    listings,
  };
})();
