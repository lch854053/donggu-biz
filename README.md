# 동구 사업자·상권 조회

광주 동구 행정·실무자를 위한 사업자 상태 일괄조회와 상가 업종 분석 서비스입니다.

## 기능

- 사업자등록번호 계속·휴업·폐업 상태 일괄조회
- 상태별 필터와 CSV 다운로드
- 광주 동구 상가업소 지도와 상호 배타적인 행정동·주요상권 조회
- 선택한 행정동 또는 주요상권의 상위 10개 업종 소분류 분석

## 환경변수

`.env.example`을 참고해 다음 키를 설정합니다.

```text
NTS_API_KEY=국세청_사업자상태조회_서비스키
SDSC_SERVICE_KEY=소상공인시장진흥공단_상가정보_서비스키
VWORLD_KEY=VWorld_2D데이터_API키
VWORLD_DOMAIN=https://biz-lookup.vercel.app
```

API 키는 브라우저 코드나 정적 JSON에 포함하지 않습니다.

## 데이터 갱신

```bash
npm install
npm run update-stores
npm run update-zones
```

상가 데이터는 `data/stores_donggu.json`, VWorld 주요상권 경계는 `data/mainbiz_zones_donggu.geojson`, 수동 등록·보정 경계는 `data/manual_mainbiz_zones_donggu.geojson`에 저장됩니다. GitHub Actions는 매월 5일 API 기반 데이터를 다시 수집하며 수동 경계는 별도 파일에 보존됩니다. `SDSC_SERVICE_KEY`와 `VWORLD_KEY` 저장소 Secret이 필요합니다.

현재 수동 등록 경계는 산수시장, 예술의 거리, 전자의 거리, 인쇄의 거리와 무등산 보리밥거리이며, 대인시장과 남광주시장은 VWorld 원본을 수동 보정 경계로 대체합니다.

VWorld 주요상권 중 금남로4가역 1~4와 문화전당역 경계는 수집 결과와 화면에서 제외합니다.

## 로컬 실행

Vercel CLI를 설치한 뒤 실행합니다.

```bash
vercel dev
```

## 테스트

```bash
npm test
```
