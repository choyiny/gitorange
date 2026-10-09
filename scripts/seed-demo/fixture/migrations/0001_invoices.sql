CREATE TABLE invoices (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  customer TEXT NOT NULL,
  issued_on TEXT NOT NULL,
  due_on TEXT NOT NULL,
  amount_cents INTEGER NOT NULL
);
