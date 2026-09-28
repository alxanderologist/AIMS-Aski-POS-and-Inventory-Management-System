require('dotenv').config();
const { assertNotProduction } = require('./lib/productionGuard');
assertNotProduction('seeder.js');

const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// Setup PostgreSQL connection pool and adapter
const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function seedData() {
  try {
    console.log('Cleaning up old database records...');
    // Delete items in reverse dependency order to prevent foreign key errors
    await prisma.purchaseReturnItem.deleteMany();
    await prisma.purchaseReturn.deleteMany();
    await prisma.receivingReportItem.deleteMany();
    await prisma.receivingReport.deleteMany();
    await prisma.purchaseOrderItem.deleteMany();
    await prisma.purchaseOrder.deleteMany();
    await prisma.transactionItem.deleteMany();
    await prisma.transaction.deleteMany();
    await prisma.reconciliation.deleteMany();
    await prisma.stockMovement.deleteMany();
    await prisma.forecastSnapshot.deleteMany(); // saved forecasts refer to the sales being wiped
    await prisma.product.deleteMany();
    await prisma.supplier.deleteMany();
    await prisma.user.deleteMany();
    console.log('Database cleared.');

    // 1. Seed Users (dev credentials — bcrypt-hashed, matches the login page's
    // documented dev accounts in frontend/src/auth/devUsers.js)
    const seedUsers = [
      { username: 'admin', password: 'admin123', role: 'ADMIN' },
      { username: 'supervisor', password: 'supervisor123', role: 'SUPERVISOR', pin: '1234' },
      { username: 'cashier', password: 'cashier123', role: 'CASHIER' },
      { username: 'accounting', password: 'accounting123', role: 'ACCOUNTING' },
      { username: 'inventory', password: 'inventory123', role: 'INVENTORY' },
    ];

    const usersByUsername = {};
    for (const u of seedUsers) {
      const hashedPassword = await bcrypt.hash(u.password, 10);
      usersByUsername[u.username] = await prisma.user.create({
        data: {
          username: u.username,
          password: hashedPassword,
          role: u.role,
          pin: u.pin ? await bcrypt.hash(u.pin, 10) : null,
        },
      });
    }
    const cashier = usersByUsername.cashier;
    const admin = usersByUsername.admin;

    console.log('Users seeded.');

    // 2. Seed Suppliers
    const suppliersData = [
      { name: 'Alpha Distributing Co.', contactPerson: 'John Doe', email: 'alpha@dist.com', phone: '09171234567' },
      { name: 'Global Goods Inc.', contactPerson: 'Jane Smith', email: 'global@goods.com', phone: '09181234568' },
      { name: 'Prime Wholesale Ltd.', contactPerson: 'Bob Johnson', email: 'prime@wholesale.com', phone: '09191234569' },
    ];

    await prisma.supplier.createMany({ data: suppliersData });
    const dbSuppliers = await prisma.supplier.findMany();
    console.log('Suppliers seeded.');

    // 3. Seed Products (With Barcodes, Cost Price, & Suppliers)
    const productsData = [
      { barcode: '4800001001', name: 'Whole Milk 1L', price: 95.0, costPrice: 80.0, category: 'Dairy', stock: 40, sku: 'DRY-001', expiryDate: new Date('2026-08-15'), supplierId: dbSuppliers[0].id },
      { barcode: '4800001002', name: 'Cheddar Cheese Block 250g', price: 180.0, costPrice: 150.0, category: 'Dairy', stock: 25, sku: 'DRY-002', expiryDate: new Date('2026-10-30'), supplierId: dbSuppliers[0].id },
      { barcode: '4800001003', name: 'Sliced Bread (Whole Wheat)', price: 75.0, costPrice: 60.0, category: 'Bakery', stock: 30, sku: 'BKY-001', expiryDate: new Date('2026-09-05'), supplierId: dbSuppliers[1].id },
      { barcode: '4800001004', name: 'Canned Tuna in Oil 180g', price: 55.0, costPrice: 42.0, category: 'Canned Goods', stock: 100, sku: 'CND-001', expiryDate: new Date('2028-06-30'), supplierId: dbSuppliers[1].id },
      { barcode: '4800001005', name: 'Instant Noodles (Chicken)', price: 18.0, costPrice: 13.0, category: 'Pantry', stock: 150, sku: 'PNT-001', expiryDate: new Date('2027-03-15'), supplierId: dbSuppliers[1].id },
      { barcode: '4800001006', name: 'Paracetamol 500mg (Box of 100)', price: 350.0, costPrice: 280.0, category: 'Pharmacy', stock: 20, sku: 'MED-001', expiryDate: new Date('2027-11-20'), supplierId: dbSuppliers[2].id },
      { barcode: '4800001007', name: 'Multi-Surface Disinfectant Spray', price: 220.0, costPrice: 175.0, category: 'Household', stock: 35, sku: 'HSH-001', expiryDate: new Date('2027-05-10'), supplierId: dbSuppliers[2].id },
      { barcode: '4800001008', name: 'White Latex Paint 4L', price: 1150.0, costPrice: 920.0, category: 'Paints', stock: 15, sku: 'PT-001', expiryDate: new Date('2027-08-31'), supplierId: dbSuppliers[2].id },
      { barcode: '4800001009', name: 'PVC Pipe Cement Glue 100ml', price: 120.0, costPrice: 90.0, category: 'Hardware', stock: 50, sku: 'HW-003', expiryDate: new Date('2026-12-31'), supplierId: dbSuppliers[2].id },
      { barcode: '4800001010', name: 'Silicon Sealant Clear', price: 280.0, costPrice: 210.0, category: 'Hardware', stock: 40, sku: 'HW-004', expiryDate: new Date('2027-02-28'), supplierId: dbSuppliers[2].id },
    ];

    await prisma.product.createMany({ data: productsData });
    const dbProducts = await prisma.product.findMany();
    await prisma.stockMovement.createMany({
      data: dbProducts.map((p) => ({
        productId: p.id,
        type: 'OPENING',
        quantity: p.stock,
        balanceAfter: p.stock,
        reason: 'Opening balance (seed)',
      })),
    });
    console.log('Products seeded.');

    // 4. Seed 30 Days of Transactions & Reconciliations
    console.log('Generating 30 days of sales transactions...');
    let transactionCounter = 1000;
    let reportCounter = 100;

    for (let i = 30; i >= 0; i--) {
      const dailyTransactionCount = Math.floor(Math.random() * 4) + 2;
      let dailyGrossSales = 0;
      let dailyTotalDiscounts = 0;
      let dailyNetSales = 0;
      let dailyCashSales = 0;

      for (let tx = 0; tx < dailyTransactionCount; tx++) {
        transactionCounter++;

        const txDate = new Date();
        txDate.setDate(txDate.getDate() - i);
        txDate.setHours(Math.floor(Math.random() * 9) + 8, Math.floor(Math.random() * 60));

        const itemCount = Math.floor(Math.random() * 3) + 1;
        const selectedProducts = [...dbProducts].sort(() => 0.5 - Math.random()).slice(0, itemCount);

        let transactionSubtotal = 0;

        const itemsToCreate = selectedProducts.map((p) => {
          const qty = Math.floor(Math.random() * 3) + 1;
          const unitPrice = Number(p.price);
          const itemSubtotal = unitPrice * qty;

          transactionSubtotal += itemSubtotal;

          return {
            productId: p.id,
            barcode: p.barcode, // Captures barcode snapshot at sale time
            name: p.name,
            unitPrice: unitPrice,
            quantity: qty,
            subtotal: itemSubtotal,
          };
        });

        const hasDiscount = Math.random() < 0.15;
        const discountPercent = hasDiscount ? 10 : 0;
        const discountAmount = (transactionSubtotal * discountPercent) / 100;
        const totalAmount = transactionSubtotal - discountAmount;

        const paymentMethods = ['CASH', 'CARD', 'E_wallet'];
        const paymentMethod = paymentMethods[Math.floor(Math.random() * paymentMethods.length)];

        dailyGrossSales += transactionSubtotal;
        dailyTotalDiscounts += discountAmount;
        dailyNetSales += totalAmount;
        if (paymentMethod === 'CASH') dailyCashSales += totalAmount;

        const dateCode = `${txDate.getFullYear()}${String(txDate.getMonth() + 1).padStart(2, '0')}${String(txDate.getDate()).padStart(2, '0')}`;
        const transactionNo = `TXN-${dateCode}-${transactionCounter}`;

        await prisma.transaction.create({
          data: {
            transactionNo,
            subtotal: transactionSubtotal,
            discountPercent,
            discountAmount,
            supervisorAuthorized: hasDiscount,
            totalAmount,
            paymentMethod,
            cashierId: cashier.id,
            createdAt: txDate,
            items: {
              create: itemsToCreate,
            },
          },
        });
      }

      // Create Daily Reconciliation (X-Reading)
      reportCounter++;
      const recDate = new Date();
      recDate.setDate(recDate.getDate() - i);
      recDate.setHours(18, 0, 0);

      const p1000 = Math.floor(dailyCashSales / 1000);
      const remainingCash = dailyCashSales % 1000;
      const p500 = Math.floor(remainingCash / 500);
      const p100 = Math.floor((remainingCash % 500) / 100);

      const cashierCash = p1000 * 1000 + p500 * 500 + p100 * 100;
      const shortOver = cashierCash - dailyCashSales;

      let status = 'BALANCED';
      if (shortOver < 0) status = 'SHORTAGE';
      if (shortOver > 0) status = 'OVERAGE';

      await prisma.reconciliation.create({
        data: {
          reportNo: `REP-${recDate.getFullYear()}${String(recDate.getMonth() + 1).padStart(2, '0')}${String(recDate.getDate()).padStart(2, '0')}-${reportCounter}`,
          reconciliationDate: recDate,
          cashierId: cashier.id,
          grossSales: dailyGrossSales,
          pointsAvailed: 0,
          totalDiscount: dailyTotalDiscounts,
          netSales: dailyNetSales,
          cashDiscount: 0,
          p1000,
          p500,
          p100,
          posCash: dailyCashSales,
          cashierCash,
          shortOver,
          status,
          notes: 'Daily automated shift closure reconciliation.',
          createdAt: recDate,
        },
      });
    }

    console.log('Seeding finished successfully!');
  } catch (error) {
    console.error('Error seeding data:', error);
  } finally {
    await prisma.$disconnect();
  }
}

seedData();
