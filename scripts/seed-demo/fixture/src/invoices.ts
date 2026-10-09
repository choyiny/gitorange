// Invoices: the shape we store, and the arithmetic on it.

export interface Invoice {
  id: number;
  number: string;
  customer: string;
  issuedOn: string;
  dueOn: string;
  amountCents: number;
}

export function invoiceNumber(sequence: number): string {
  return `INV-${String(sequence).padStart(4, '0')}`;
}

export function newInvoice(
  sequence: number,
  customer: string,
  amountCents: number,
  issuedOn: Date,
  termsDays = 30
): Invoice {
  const dueOn = new Date(issuedOn.getTime() + termsDays * 86_400_000);
  return {
    id: sequence,
    number: invoiceNumber(sequence),
    customer,
    issuedOn: issuedOn.toISOString().slice(0, 10),
    dueOn: dueOn.toISOString().slice(0, 10),
    amountCents,
  };
}

export function total(invoices: Invoice[]): number {
  return invoices.reduce((sum, invoice) => sum + invoice.amountCents, 0);
}
