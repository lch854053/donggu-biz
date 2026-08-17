export function assertSnapshotHealthy({ totalCount, validCount, previousCount = null }) {
  if (!Number.isInteger(totalCount) || totalCount < 1000) {
    throw new Error(`상류 전체 건수가 비정상입니다: ${totalCount}`);
  }
  if (validCount < totalCount * 0.98) {
    throw new Error(`유효 데이터가 비정상적으로 적습니다: ${validCount}/${totalCount}`);
  }
  if (Number.isInteger(previousCount) && previousCount > 0 && validCount < previousCount * 0.8) {
    throw new Error(`기존 데이터 대비 20% 이상 감소했습니다: ${previousCount} -> ${validCount}`);
  }
}
