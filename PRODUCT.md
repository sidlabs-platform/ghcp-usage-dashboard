# Product

## Register

product

## Users

Engineering leaders, platform administrators, finance stakeholders, and GitHub Copilot program owners use this dashboard while reviewing adoption, delivery, security, and billing signals across enterprises, organizations, teams, and users.

## Product Purpose

GHCP Usage Dashboard consolidates GitHub Copilot usage metrics, GHAS security posture, seat data, and billing reports into a local Next.js dashboard backed by SQLite. Success means users can answer operational questions quickly, trust metric semantics, filter by organizational scope, and export evidence without re-syncing or resetting local data.

## Brand Personality

Precise, trustworthy, and operational. The interface should feel like a focused analytics tool: dense enough for real work, calm enough for repeated review, and explicit about data coverage caveats.

## Anti-references

Avoid decorative SaaS dashboards, marketing-style hero metrics, gratuitous gradients, glassmorphism, and vague “AI insight” copy. Avoid UI patterns that make financial or usage data feel approximate when the underlying data has precise definitions and caveats.

## Design Principles

1. Prioritize trusted data interpretation over visual novelty.
2. Keep navigation and table interactions familiar for dashboard users.
3. Surface scope, date range, and coverage caveats where they affect interpretation.
4. Preserve performance by aggregating in SQL and paginating large result sets.
5. Degrade gracefully when optional or newly introduced API fields are absent.

## Accessibility & Inclusion

Use the existing light/dark theme tokens, maintain WCAG AA contrast for text, preserve keyboard-accessible table sorting and navigation, and honor reduced-motion preferences through existing global motion safeguards.
