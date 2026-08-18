# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences served by the same product, in different situations:

- **Attendees / public**: people browsing and buying tickets to La Grailla's events (parties, "caseta de feria" style fiestas), buying merch in the shop, or requesting sponsorship. Mostly mobile, deciding quickly whether to attend and buy.
- **Organizer / staff**: La Grailla's own team running the admin panel — managing events, ticket types, capacity ("aforo"), orders, shop products, sponsors, users, and box-office ("taquilla") sales with QR scanning at the door.

## Product Purpose

La Grailla is the platform for La Grailla's own events business: it sells tickets and merch to the public, and gives the organizing team the operational tools to run each event — capacity control, door scanning, box-office sales, guest lists/invitations, sponsor requests, and wallet passes (Apple/Google).

## Positioning

Not a generic ticketing marketplace (unlike Fever/Eventbrite). Two things together make it distinct:

1. It **is** the event producer/brand itself — La Grailla organizes its own parties with its own identity ("Good Vibes"), not third-party events.
2. It bundles the full operational loop in one system: online sales, real-time capacity alerts, QR-based door control, box-office/staff sales channel, and wallet passes — not just a storefront.

## Operating Context

- Public site: event listings (`/eventos`), event detail, checkout/confirmation, merch shop (`/tienda`) with its own checkout, sponsor request form, login/signup (`/acceso`, `/auth/login`).
- Admin panel (`/admin`): events, ticket types, capacity ("aforo") with threshold alerts (80/95/100%), orders, shop products, shop orders, sponsors, users, stats/estadisticas, app configuration.
- Staff/box-office flow: `taquilla` sales channel (in-person sales) and `/api/scan` for QR check-in at the door, logged per ticket (`ScanLog`).
- Guest lists and invitations exist alongside paid tickets (`GuestList`, `Invitation`) for comped/guest entries.
- Tickets support Apple Wallet / Google Wallet passes and PDF generation.
- Payments: Stripe integration (`lib/payment-adapter.ts`), plus cash/free payment methods for box-office sales.
- Spanish-language product; admin contact is `grupolagrailla@gmail.com`.

## Capabilities and Constraints

- Roles: `ADMIN`, `TAQUILLA` (box office), `USER`.
- Events have capacity tracking with automatic alert thresholds and a minimum age requirement (default 18+).
- Orders/tickets/shop-orders each have their own status lifecycle (pending/completed/cancelled/refunded, and shop-specific shipped/delivered states).
- Auth via NextAuth (credentials + Prisma adapter).
- Next.js 14 (App Router) + Prisma/PostgreSQL, Tailwind + shadcn/Radix component library already in place (see `STYLE_GUIDE.md`).

## Brand Commitments

- Name: **La Grailla**. Existing tagline in code: "Good Vibes & Eventos" / "caseta de feria, eventos, fiestas y las mejores noches."
- No visual identity (palette, typography, imagery style) is locked yet — the user plans to give it a look tied to the brand later. Do not invent or lock a visual world now.

## Evidence on Hand

- No case studies, testimonials, or press on hand. `public/og-image.png` and `public/favicon.svg` exist as current assets but are not confirmed as durable brand marks.

## Product Principles

1. Serve attendees and staff as equally primary audiences — public-facing flows and admin/operational flows are both core product surfaces, not one a wrapper around the other.
2. The brand *is* the product: La Grailla is the event producer, not a neutral marketplace — voice and presentation should read as belonging to a specific producer with a specific vibe, not a generic ticketing tool.
3. Operational reliability (capacity accuracy, scan validity, payment state) is a product requirement on par with the public storefront experience — this is a live-events business, not a content site.

## Accessibility & Inclusion

No product-specific accessibility requirement established beyond standard web accessibility practice.
