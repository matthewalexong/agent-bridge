# Standardized performance evidence target

This target prevents declared or controlled performance claims from masquerading
as comparable independently measured results.

The harness must:

1. separate declared specifications from measured performance;
2. use distinct `declared:<metric>` and `performance:<metric>` attributes;
3. bind every measurement to the exact product, variant, configuration, and
   firmware when firmware can affect results;
4. require one exact sourced protocol ID and version across candidates;
5. require a complete identical inventory of material test conditions;
6. reject unstated unit, workload, protocol, mode, or scoring conversions;
7. require verified independent source identity, funding disclosure, and
   editorial-independence evidence, and deduplicate each lab;
8. keep manufacturer, retailer, funded, unknown-funding, and editorially
   unverified tests classified as controlled claims;
9. enforce sample-size, complete-run, and freshness requirements;
10. require current sourced instrument calibration when the metric requires it;
11. require sourced uncertainty bounds that contain the point and remain within
    policy;
12. preserve inter-lab disagreement as conflict rather than averaging it away;
13. admit performance values to product evidence only through a comparable
    performance artifact;
14. allow preference constraints to require the measured-performance evidence
    role;
15. require a fresh performance dossier artifact whenever measured performance
    affected ranking; and
16. never rank, select, authorize checkout, or authorize purchase.

Hermes or OpenClaw remains the main brain for evidence collection and
explanation. Gemma may normalize already verified unit labels, dates, and exact
identifiers. Gemma must not judge protocol or condition equivalence, funding,
independence, uncertainty, conflicts, clearance, or product choice.
