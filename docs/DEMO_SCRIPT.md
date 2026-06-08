# RetailDaddy Demo Script Guide

Use `demo/retaildaddy-demo.template.json` as the starting point for a real client demo.
Set `DEMO_SCRIPT_PATH` to your customized JSON file and `PRODUCT_KB_PATH` to the product
knowledge Markdown file the question-answering brain should use.

## Required Setup

Preflight supports three modes:

- `rehearse`: requires `SARVAM_API_KEY`, `PRODUCT_URL`, `DEMO_SCRIPT_PATH`, and `PRODUCT_KB_PATH`.
- `demo`: requires everything in `rehearse` plus `GOOGLE_MEET_URL`.
- `launch`: requires everything in `demo` plus `MEET_AUTO_PRESENT=true` and `AUDIO_CAPTURE_COMMAND`.

Use `launch` when you want unattended live readiness. Use `demo` when a human operator will start
screen sharing or feed recorded client audio manually.

## Script Shape

The JSON file must be an object with:

- `title`: Human-readable demo title.
- `language`: Language code for planning and voice consistency.
- `opening`: First line spoken before the walkthrough starts.
- `closing`: Final line spoken after the scripted steps.
- `steps`: Ordered walkthrough steps.

Each step should include:

- `id`: Stable identifier, unique across the script.
- `title`: Short label used in logs and routing.
- `say`: What the agent says after performing the step action.
- `action`: Browser action for the product page.
- `highlight`: CSS selector list for the feature area to outline.
- `zoom`: Numeric browser zoom for this step.
- `pauseMs`: Optional dwell time after action, zoom, and highlight.
- `keywords`: Phrases used to route client questions back to this step.

Supported `action.type` values are:

- `navigate`: Requires `url`, usually a route like `/inventory`.
- `click`: Requires `selector`.
- `fill`: Requires `selector` and `value`.
- `wait`: Uses `ms`, defaulting to 1000 if omitted.
- `none`: Speaks without changing the page.

## Selectors

Prefer stable product attributes such as:

```html
<section data-demo="inventory-table">...</section>
```

Then reference them in the script:

```json
"highlight": "[data-demo='inventory-table'], table, main"
```

The highlight field accepts a comma-separated fallback list. The first selector that exists on the
page is outlined and scrolled into view. Action selectors should be more precise because `click` and
`fill` use the first matching element.

## Zoom And Highlights

Use `zoom` to make dense tables, charts, and controls visible during screen sharing. Keep normal
steps between `1.0` and `1.15`; use up to `1.25` for dense UI. The controller clamps zoom to the
`0.75` to `1.5` range.

Use `highlight` for the exact area the client should inspect. Good targets are cards, tables,
charts, forms, and primary workflow panels. Avoid `body` except as a last fallback.

## Question Routing

When the client asks a question, `findStepForQuestion` checks each step's `keywords` and revisits
the best matching feature before answering. Add practical client phrases, not just internal feature
names.

Example:

```json
"keywords": ["inventory", "stock", "sku", "reorder", "low stock", "warehouse"]
```

Keep keywords specific. If both dashboard and reports use `analytics`, add extra phrases such as
`daily summary` for dashboard and `margin report` for reports so the revisit behavior is predictable.

## Customization Checklist

- Replace template routes with real RetailDaddy routes.
- Add `data-demo` attributes to important UI elements in the product.
- Keep every step's `say` text short enough to speak naturally.
- Add keywords for every feature a client may ask about.
- Populate product knowledge with pricing, integrations, implementation steps, support limits, and
  any claims the agent is allowed to answer.
- Run preflight before a live call and treat errors as blockers.
