function amount(value) {
  if (value === "" || value == null) return null;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

const SUPPORTED_STATEMENT_TYPES = new Set(["110", "120"]);

function hasValidAccountingEquation(statement) {
  const { totalAssets, totalDebt, totalEquity } = statement;
  if (![totalAssets, totalDebt, totalEquity].every((value) => typeof value === "number")) return true;
  const difference = Math.abs(totalAssets - totalDebt - totalEquity);
  return difference <= Math.max(1000000, Math.abs(totalAssets) * 0.005);
}

export function compactFinancialStatement(item) {
  const statement = {
    baseDate: String(item.basDt || "").replace(/[^0-9]/g, ""),
    businessYear: String(item.bizYear || "").replace(/[^0-9]/g, ""),
    statementTypeCode: String(item.fnclDcd || ""),
    statementTypeName: String(item.fnclDcdNm || "").trim(),
    currency: String(item.curCd || "").trim(),
    sales: amount(item.enpSaleAmt),
    operatingProfit: amount(item.enpBzopPft),
    comprehensiveIncome: amount(item.iclsPalClcAmt),
    netIncome: amount(item.enpCrtmNpf),
    totalAssets: amount(item.enpTastAmt),
    totalDebt: amount(item.enpTdbtAmt),
    totalEquity: amount(item.enpTcptAmt),
    capital: amount(item.enpCptlAmt),
    debtRatio: null
  };
  if (statement.totalDebt != null && statement.totalEquity) {
    statement.debtRatio = statement.totalDebt / statement.totalEquity * 100;
  }
  return statement;
}

export function validFinancialStatements(items, corporateRegistrationNumber, businessYear) {
  const crno = String(corporateRegistrationNumber || "").replace(/[^0-9]/g, "");
  const year = String(businessYear || "");
  const statements = new Map();
  for (const item of items) {
    if (String(item.crno || "").replace(/[^0-9]/g, "") !== crno) continue;
    if (String(item.bizYear || "") !== year) continue;
    const statement = compactFinancialStatement(item);
    if (!SUPPORTED_STATEMENT_TYPES.has(statement.statementTypeCode) || !statement.baseDate) continue;
    if (!hasValidAccountingEquation(statement)) continue;
    statements.set(statement.statementTypeCode, statement);
  }
  return [...statements.values()].sort((left, right) => left.statementTypeCode.localeCompare(right.statementTypeCode));
}
