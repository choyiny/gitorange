import { formatMoney } from '../currency';
import { newInvoice, total, type Invoice } from '../invoices';

const invoices: Invoice[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function listInvoices(): Response {
  return json({
    invoices: invoices.map((i) => ({
      ...i,
      amount: formatMoney(i.amountCents),
    })),
    total: formatMoney(total(invoices)),
  });
}

export async function createInvoice(request: Request): Promise<Response> {
  const body = (await request.json()) as {
    customer?: string;
    amountCents?: number;
  };
  if (!body.customer || !Number.isInteger(body.amountCents)) {
    return json({ error: 'customer and amountCents are required' }, 400);
  }
  const invoice = newInvoice(
    invoices.length + 1,
    body.customer,
    body.amountCents!,
    new Date()
  );
  invoices.push(invoice);
  return json(invoice, 201);
}

export function handle(request: Request): Promise<Response> | Response {
  const url = new URL(request.url);
  if (url.pathname === '/invoices' && request.method === 'GET') {
    return listInvoices();
  }
  if (url.pathname === '/invoices' && request.method === 'POST') {
    return createInvoice(request);
  }
  return json({ error: 'Not found' }, 404);
}
