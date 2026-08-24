# AMAN RC4.2 live test

Authorized test target: `https://amaniq1.netlify.app`

## Required repository secrets

- `AMAN_OWNER_EMAIL`
- `AMAN_OWNER_PASSWORD`

The workflow never prints these values. It authenticates through Supabase Auth and keeps the returned access token in runner memory only.

## Safe sequence

1. A push to `main` runs `smoke` only, with 25 concurrent public and 25 authenticated requests.
2. Review the uploaded JSON and Markdown artifacts.
3. If smoke passes, manually run the workflow with mode `load`.
4. Load ramps through 25, 50, 100, 200, 500 and 1,000 concurrent requests and stops when the combined error rate exceeds 1%.
5. Cleanup is not automatic. Review `sql/cleanup-test-tenants.sql`, preview the exact tenants, and run deletion only after explicit approval.

## Scope

The smoke workflow verifies RC4.2 publication, owner authentication, platform snapshot, creation of two isolated test tenants, distinct organization branding, logo validation, rejection of SVG and unsafe colors, public-data minimization, and a small authenticated/public concurrency test.

The load workflow measures real Netlify/Supabase HTTP requests. It does not claim that repeated requests using one authenticated owner token equal 1,000 distinct human accounts; the report labels the result as concurrent virtual requests.
