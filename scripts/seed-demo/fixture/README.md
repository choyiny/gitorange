# Invoices

A small invoicing service for a one-person consultancy. It keeps invoices in a
database, works out totals, and serves a short JSON API.

## Endpoints

| Method | Path        | What it does                    |
| ------ | ----------- | ------------------------------- |
| GET    | `/invoices` | Lists invoices with their total |
| POST   | `/invoices` | Creates an invoice              |

## Running it

```sh
yarn install
yarn dev
```

Run the tests with `yarn test`. They also run on every push to `main`.

## Money

Amounts are stored as whole cents. Every invoice so far is in Canadian dollars.
