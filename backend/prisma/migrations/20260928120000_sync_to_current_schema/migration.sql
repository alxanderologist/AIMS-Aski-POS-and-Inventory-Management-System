-- CreateEnum
CREATE TYPE "Role" AS ENUM ('CASHIER', 'SUPERVISOR', 'ADMIN', 'ACCOUNTING', 'INVENTORY');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'E_wallet');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('BALANCED', 'SHORTAGE', 'OVERAGE', 'COMPLETED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'PENDING', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('OPENING', 'PURCHASE_RECEIPT', 'MANUAL_ADD', 'SALE', 'PURCHASE_RETURN', 'ADJUSTMENT', 'VOID');

-- DropForeignKey
ALTER TABLE "PendingOrderItem" DROP CONSTRAINT "PendingOrderItem_pendingOrderId_fkey";

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "barcode" TEXT,
ADD COLUMN     "costPrice" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "expiryDate" TIMESTAMP(3),
ADD COLUMN     "minStock" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "supplierId" INTEGER,
ADD COLUMN     "unit" TEXT NOT NULL DEFAULT 'PC/S',
ALTER COLUMN "price" SET DATA TYPE DECIMAL(10,2);

-- AlterTable
ALTER TABLE "Reconciliation" DROP COLUMN "c25",
DROP COLUMN "expectedSystemCash",
DROP COLUMN "totalCountedCash",
DROP COLUMN "variance",
ADD COLUMN     "businessDate" TEXT,
ADD COLUMN     "cashDiscount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "cashierCash" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "grossSales" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "netSales" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "p0_01" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "p0_05" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "p0_10" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "p0_25" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "p0_50" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pointsAvailed" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "posCash" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "reportNo" TEXT NOT NULL,
ADD COLUMN     "shortOver" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "totalDiscount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "voidAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "voidCount" INTEGER NOT NULL DEFAULT 0,
DROP COLUMN "cashierId",
ADD COLUMN     "cashierId" INTEGER NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "ReconciliationStatus" NOT NULL DEFAULT 'COMPLETED';

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "approvedById" INTEGER,
ADD COLUMN     "memberId" INTEGER,
ADD COLUMN     "referenceNumber" TEXT,
ALTER COLUMN "subtotal" SET DATA TYPE DECIMAL(10,2),
ALTER COLUMN "discountPercent" SET DATA TYPE DECIMAL(5,2),
ALTER COLUMN "discountAmount" SET DATA TYPE DECIMAL(10,2),
ALTER COLUMN "totalAmount" SET DATA TYPE DECIMAL(10,2),
DROP COLUMN "paymentMethod",
ADD COLUMN     "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'CASH',
DROP COLUMN "cashierId",
ADD COLUMN     "cashierId" INTEGER NOT NULL;

-- AlterTable
ALTER TABLE "TransactionItem" ADD COLUMN     "barcode" TEXT,
ALTER COLUMN "unitPrice" SET DATA TYPE DECIMAL(10,2),
ALTER COLUMN "subtotal" SET DATA TYPE DECIMAL(10,2);

-- DropTable
DROP TABLE "PendingOrder";

-- DropTable
DROP TABLE "PendingOrderItem";

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "fullName" TEXT,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'CASHIER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "pin" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "contactPerson" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "leadTimeDays" INTEGER NOT NULL DEFAULT 7,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBatch" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "supplierId" INTEGER,
    "unitCost" DECIMAL(10,2) NOT NULL,
    "qtyReceived" INTEGER NOT NULL,
    "qtyRemaining" INTEGER NOT NULL,
    "referenceType" TEXT,
    "referenceId" INTEGER,
    "referenceNo" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" SERIAL NOT NULL,
    "productId" INTEGER NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reason" TEXT,
    "referenceType" TEXT,
    "referenceId" INTEGER,
    "referenceNo" TEXT,
    "userId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Member" (
    "id" SERIAL NOT NULL,
    "cardNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "points" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberPointsLedger" (
    "id" SERIAL NOT NULL,
    "memberId" INTEGER NOT NULL,
    "transactionId" INTEGER NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'EARN',
    "points" DECIMAL(10,2) NOT NULL,
    "balanceAfter" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberPointsLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaleVoid" (
    "id" SERIAL NOT NULL,
    "voidNo" TEXT NOT NULL,
    "transactionId" INTEGER NOT NULL,
    "voidedById" INTEGER NOT NULL,
    "approvedById" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "discountAmount" DECIMAL(10,2) NOT NULL,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL,
    "pointsReversed" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaleVoid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionItemBatch" (
    "id" SERIAL NOT NULL,
    "transactionItemId" INTEGER NOT NULL,
    "batchId" INTEGER,
    "quantity" INTEGER NOT NULL,
    "unitCost" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "TransactionItemBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZReadingLog" (
    "id" SERIAL NOT NULL,
    "reportNo" TEXT NOT NULL,
    "cashierId" INTEGER NOT NULL,
    "approvedById" INTEGER NOT NULL,
    "fromTransactionId" INTEGER,
    "toTransactionId" INTEGER,
    "beginTransactionNo" TEXT,
    "endTransactionNo" TEXT,
    "transactionCount" INTEGER NOT NULL DEFAULT 0,
    "grossSales" DECIMAL(12,2) NOT NULL,
    "totalDiscount" DECIMAL(12,2) NOT NULL,
    "pointsAvailed" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "voidCount" INTEGER NOT NULL DEFAULT 0,
    "voidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "netSales" DECIMAL(12,2) NOT NULL,
    "grandTotalBefore" DECIMAL(14,2) NOT NULL,
    "grandTotalAfter" DECIMAL(14,2) NOT NULL,
    "paymentBreakdown" JSONB NOT NULL,
    "categoryBreakdown" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ZReadingLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" SERIAL NOT NULL,
    "poNumber" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "terms" TEXT DEFAULT 'N/A',
    "remarks" TEXT,
    "preparedBy" TEXT,
    "shipTo" TEXT,
    "shippingAddress" TEXT,
    "purpose" TEXT,
    "tagging" TEXT DEFAULT 'Regular',
    "discount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "supplierId" INTEGER NOT NULL,
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderItem" (
    "id" SERIAL NOT NULL,
    "purchaseOrderId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCost" DECIMAL(10,2) NOT NULL,
    "subtotal" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "PurchaseOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceivingReport" (
    "id" SERIAL NOT NULL,
    "rrNumber" TEXT NOT NULL,
    "deliveryNote" TEXT,
    "invoiceNo" TEXT,
    "terms" TEXT DEFAULT 'N/A',
    "remarks" TEXT,
    "purchaseOrderId" INTEGER NOT NULL,
    "supplierId" INTEGER NOT NULL,
    "receivedById" INTEGER NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceivingReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceivingReportItem" (
    "id" SERIAL NOT NULL,
    "receivingReportId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCost" DECIMAL(10,2) NOT NULL,
    "subtotal" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "ReceivingReportItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseReturn" (
    "id" SERIAL NOT NULL,
    "returnNo" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "terms" TEXT DEFAULT 'N/A',
    "remarks" TEXT,
    "supplierId" INTEGER NOT NULL,
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseReturn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseReturnItem" (
    "id" SERIAL NOT NULL,
    "purchaseReturnId" INTEGER NOT NULL,
    "receivingReportId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCost" DECIMAL(10,2) NOT NULL,
    "subtotal" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "PurchaseReturnItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" SERIAL NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" INTEGER,
    "actorUsername" TEXT NOT NULL,
    "targetUserId" INTEGER,
    "targetUsername" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForecastSnapshot" (
    "id" SERIAL NOT NULL,
    "asOf" DATE NOT NULL,
    "model" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "revenue7" DECIMAL(12,2) NOT NULL,
    "revenue30" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForecastSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForecastSnapshotItem" (
    "id" SERIAL NOT NULL,
    "snapshotId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "sku" TEXT NOT NULL,
    "forecast7" DOUBLE PRECISION NOT NULL,
    "confidence" TEXT NOT NULL,

    CONSTRAINT "ForecastSnapshotItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "StockBatch_productId_receivedAt_idx" ON "StockBatch"("productId", "receivedAt");

-- CreateIndex
CREATE INDEX "StockBatch_productId_qtyRemaining_idx" ON "StockBatch"("productId", "qtyRemaining");

-- CreateIndex
CREATE INDEX "StockMovement_productId_createdAt_idx" ON "StockMovement"("productId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMovement_type_createdAt_idx" ON "StockMovement"("type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Member_cardNumber_key" ON "Member"("cardNumber");

-- CreateIndex
CREATE INDEX "MemberPointsLedger_memberId_createdAt_idx" ON "MemberPointsLedger"("memberId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MemberPointsLedger_transactionId_type_key" ON "MemberPointsLedger"("transactionId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "SaleVoid_voidNo_key" ON "SaleVoid"("voidNo");

-- CreateIndex
CREATE UNIQUE INDEX "SaleVoid_transactionId_key" ON "SaleVoid"("transactionId");

-- CreateIndex
CREATE INDEX "SaleVoid_voidedById_createdAt_idx" ON "SaleVoid"("voidedById", "createdAt");

-- CreateIndex
CREATE INDEX "SaleVoid_createdAt_idx" ON "SaleVoid"("createdAt");

-- CreateIndex
CREATE INDEX "TransactionItemBatch_transactionItemId_idx" ON "TransactionItemBatch"("transactionItemId");

-- CreateIndex
CREATE INDEX "TransactionItemBatch_batchId_idx" ON "TransactionItemBatch"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "ZReadingLog_reportNo_key" ON "ZReadingLog"("reportNo");

-- CreateIndex
CREATE INDEX "ZReadingLog_cashierId_createdAt_idx" ON "ZReadingLog"("cashierId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_poNumber_key" ON "PurchaseOrder"("poNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ReceivingReport_rrNumber_key" ON "ReceivingReport"("rrNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ReceivingReport_purchaseOrderId_key" ON "ReceivingReport"("purchaseOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseReturn_returnNo_key" ON "PurchaseReturn"("returnNo");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_targetUserId_createdAt_idx" ON "AuditLog"("targetUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ForecastSnapshot_asOf_model_key" ON "ForecastSnapshot"("asOf", "model");

-- CreateIndex
CREATE UNIQUE INDEX "ForecastSnapshotItem_snapshotId_productId_key" ON "ForecastSnapshotItem"("snapshotId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_barcode_key" ON "Product"("barcode");

-- CreateIndex
CREATE INDEX "Product_barcode_name_idx" ON "Product"("barcode", "name");

-- CreateIndex
CREATE INDEX "Product_category_idx" ON "Product"("category");

-- CreateIndex
CREATE UNIQUE INDEX "Reconciliation_reportNo_key" ON "Reconciliation"("reportNo");

-- CreateIndex
CREATE INDEX "Reconciliation_cashierId_businessDate_idx" ON "Reconciliation"("cashierId", "businessDate");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBatch" ADD CONSTRAINT "StockBatch_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBatch" ADD CONSTRAINT "StockBatch_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_cashierId_fkey" FOREIGN KEY ("cashierId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberPointsLedger" ADD CONSTRAINT "MemberPointsLedger_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberPointsLedger" ADD CONSTRAINT "MemberPointsLedger_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleVoid" ADD CONSTRAINT "SaleVoid_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleVoid" ADD CONSTRAINT "SaleVoid_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaleVoid" ADD CONSTRAINT "SaleVoid_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionItem" ADD CONSTRAINT "TransactionItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionItemBatch" ADD CONSTRAINT "TransactionItemBatch_transactionItemId_fkey" FOREIGN KEY ("transactionItemId") REFERENCES "TransactionItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionItemBatch" ADD CONSTRAINT "TransactionItemBatch_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "StockBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reconciliation" ADD CONSTRAINT "Reconciliation_cashierId_fkey" FOREIGN KEY ("cashierId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZReadingLog" ADD CONSTRAINT "ZReadingLog_cashierId_fkey" FOREIGN KEY ("cashierId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZReadingLog" ADD CONSTRAINT "ZReadingLog_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivingReport" ADD CONSTRAINT "ReceivingReport_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivingReport" ADD CONSTRAINT "ReceivingReport_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivingReport" ADD CONSTRAINT "ReceivingReport_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivingReportItem" ADD CONSTRAINT "ReceivingReportItem_receivingReportId_fkey" FOREIGN KEY ("receivingReportId") REFERENCES "ReceivingReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceivingReportItem" ADD CONSTRAINT "ReceivingReportItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturn" ADD CONSTRAINT "PurchaseReturn_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturn" ADD CONSTRAINT "PurchaseReturn_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturnItem" ADD CONSTRAINT "PurchaseReturnItem_purchaseReturnId_fkey" FOREIGN KEY ("purchaseReturnId") REFERENCES "PurchaseReturn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturnItem" ADD CONSTRAINT "PurchaseReturnItem_receivingReportId_fkey" FOREIGN KEY ("receivingReportId") REFERENCES "ReceivingReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseReturnItem" ADD CONSTRAINT "PurchaseReturnItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForecastSnapshotItem" ADD CONSTRAINT "ForecastSnapshotItem_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "ForecastSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
