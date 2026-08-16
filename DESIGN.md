---
name: "동구 사업자·상권 조회"
description: "사업자 상태와 동구 상권 맥락을 한 업무대에서 다루는 청흑색 관제형 인터페이스"
colors:
  background: "#0d1017"
  surface: "#151925"
  surface-raised: "#1c2231"
  surface-soft: "#111621"
  line: "#2d3548"
  line-strong: "#414c64"
  text: "#f1f4fa"
  text-secondary: "#b7c0d3"
  text-muted: "#8490aa"
  accent: "#5b98ff"
  accent-strong: "#83b3ff"
  accent-dark: "#123467"
  success: "#45d69a"
  success-bg: "#102d24"
  warning: "#f2ce68"
  warning-bg: "#30270f"
  danger: "#ff8585"
  danger-bg: "#341719"
typography:
  headline:
    fontFamily: "Noto Sans KR, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.35
  title:
    fontFamily: "Noto Sans KR, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.55
  body:
    fontFamily: "Noto Sans KR, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Noto Sans KR, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.4
  data:
    fontFamily: "JetBrains Mono, monospace"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: "4px"
  sm: "6px"
  control: "7px"
  md: "8px"
  lg: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "28px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.background}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "9px 15px"
    height: "40px"
  button-secondary:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "9px 15px"
    height: "40px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "9px 15px"
    height: "40px"
  button-export:
    backgroundColor: "{colors.success-bg}"
    textColor: "{colors.success}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "9px 15px"
    height: "40px"
  chip-default:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "7px 11px"
    height: "36px"
  chip-active:
    backgroundColor: "{colors.accent-dark}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "7px 11px"
    height: "36px"
  input-field:
    backgroundColor: "{colors.surface-soft}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
    height: "40px"
  zone-layer-toggle:
    backgroundColor: "{colors.surface-soft}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
    height: "40px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "16px"
---

# Design System: 동구 사업자·상권 조회

## Overview

**Creative North Star: "동구 통합 관제대"**

이 시각 세계는 사업자 한 건의 상태와 동구 전체 상가의 맥락을 같은 업무대 위에 올려놓는다. 청흑색 무광 바탕, 얇은 구조선, 제한된 청색 동작색이 화면을 관제 도구처럼 단단하게 묶고, 장식보다 조회 조건과 결과의 관계를 먼저 보이게 한다.

밀도는 높지만 역할은 명확하다. 산세리프 한글은 설명과 조작을 담당하고, 고정폭 숫자는 건수·등록번호·거리·좌표처럼 비교해야 하는 데이터를 정렬한다. 의미색은 상태 배지와 경고에 집중하되, 지도에서는 황색 주요상권 경계와 청색 선택 경계로 공간 상태를 구분한다. 지도, 표와 상권 분석 패널은 동일한 표면·선·타입 체계를 공유한다.

**Key Characteristics:**
- 무광 청흑색 표면이 층을 이루는 어두운 업무 환경
- 청색 동작·선택과 황색 지도 경계를 굵기·채움 차이로 보강하는 체계
- 얇은 경계선과 작은 곡률로 구획한 고밀도 정보 구조
- 고정폭 숫자와 간결한 상태 배지 중심의 판독 방식
- 넓은 화면에서는 병렬 관제, 좁은 화면에서는 순차 업무 흐름

## Colors

차가운 청흑색 중립 팔레트 위에서 동작 청색과 세 가지 의미색만 제한적으로 빛난다.

### Primary
- **관제 청색:** 주요 실행, 활성 탭, 선택 칩, 진행 막대, 요약 막대와 지도 분석 범위를 하나의 상호작용 언어로 연결한다.
- **신호 청색:** 활성 텍스트, 링크와 포커스 외곽선처럼 어두운 표면 위에서 더 높은 명료도가 필요한 곳에 쓴다.
- **심층 청색:** 선택된 칩과 브랜드 마크의 배경으로 사용해 청색 상태를 면으로 표시하되 밝은 동작색과 경쟁하지 않는다.

### Secondary
- **확인 녹색:** 조회 성공, 계속사업자와 CSV 내보내기를 나타낸다. 연한 전경색과 짙은 녹색 배경을 항상 함께 사용한다.
- **주의·경계 황색:** 휴업과 해석 유의사항을 표시하고, 지도에서는 선택되지 않은 VWorld 주요상권을 2px 선과 낮은 채움으로 구획한다.
- **경고 적색:** 형식 오류, 폐업, 데이터 로드 실패처럼 조치가 필요한 상태를 표시한다.

### Neutral
- **심야 바탕:** 페이지 전체와 선택 영역의 가장 깊은 기반이다.
- **무광 패널:** 카드, 통계 스트립과 세로 레일의 기본 표면이다.
- **상승 표면:** 보조 버튼, 비활성 칩과 중립 배지처럼 조작 가능한 요소를 바탕에서 한 단계 분리한다.
- **구조선:** 패널, 행, 레일과 표의 경계를 얇게 구획한다. 강한 구조선은 입력 테두리와 오버레이 경계에 쓴다.
- **고대비 본문:** 제목, 값과 핵심 결과에 쓴다. 보조 텍스트는 설명과 출처에, 흐린 텍스트는 순번과 낮은 우선순위 메타데이터에 쓴다.

**The One Blue Channel Rule.** 청색은 상호작용, 선택, 진행과 지도 분석에만 사용한다. 장식 면적을 늘리기 위해 추가하지 않는다.

**The Semantic Pair Rule.** 사업자 상태의 성공·주의·경고는 전경색과 전용 어두운 배경을 쌍으로 사용한다. 지도 경계는 색에 더해 선 굵기, 채움 농도, 선택기와 분석 패널을 함께 바꿔 상태를 전달한다.

## Typography

**Display Font:** Noto Sans KR (sans-serif fallback)
**Body Font:** Noto Sans KR (sans-serif fallback)
**Label/Mono Font:** JetBrains Mono (monospace fallback)

**Character:** 굵기와 크기 차이를 절제한 산세리프가 업무 문장을 빠르게 훑게 하고, 고정폭 글꼴이 숫자와 코드의 수직 정렬을 보장한다. 별도 장식용 서체나 대형 디스플레이 계층은 없다.

### Hierarchy
- **Headline** (700, 24px, 1.35): 제품명, 입력 작업명, 결과와 상권 화면의 주요 제목에 사용한다.
- **Title** (700, 15px, 1.55): 레일 제목, 안내 제목, 목록의 핵심 이름과 작은 섹션 표제에 사용한다.
- **Body** (400, 15px, 1.55): 설명, 버튼, 표 데이터와 일반 업무 문장에 사용한다.
- **Label** (600, 12px, 1.4): 필드 라벨, 출처 태그, 표 머리글, 메타데이터와 주의 문구에 사용한다.
- **Data** (400 또는 600, 12–28px, 1–1.5): 등록번호, 건수, 좌표, 거리, 진행 상태와 요약 지표에 사용하며 tabular numerals를 유지한다.

**The Data Alignment Rule.** 비교·복사·스캔 대상인 숫자와 코드는 고정폭으로 표시하고, 설명 문장까지 고정폭으로 확장하지 않는다.

## Layout

콘텐츠는 최대 1560px의 넓은 작업면 안에 놓이며, 좌우 여백은 화면 폭에 따라 18–40px로 변한다. 상단에는 제품 식별 헤더와 동급 서비스 탭이 고정된 순서로 이어지고, 본문은 28px 위 여백과 72px 아래 여백을 갖는다. 기본 간격은 4px 단위에서 출발해 8px, 12px, 16px, 20px, 28px로 커진다.

사업자 조회는 유연한 입력 스테이션과 280px 기준 안내를 나란히 배치한다. 상권 분석은 250px 필터 레일, 최소 420px 지도, 290px 분석 레일의 세 구역으로 구성하며 지도 높이는 최소 650px이다. 통계는 전체 업소, 현재 조건, 행정동, 최다 업종, 주요상권 포함을 같은 폭으로 놓는 다섯 칸 스트립이며, 결과는 가로 스크롤 가능한 고밀도 표로 표현한다.

1120px 이하에서는 분석 레일이 지도 아래 전체 폭으로 이동해 세 열의 요약 영역이 된다. 주요상권 분석은 첫째 열, 반경 조작과 결과는 둘째 열, 해석 유의사항은 셋째 열에 놓인다. 780px 이하에서는 모든 업무 구역이 세로 흐름으로 바뀌고, 다섯 지표는 두 칸씩 두 행을 만든 뒤 마지막 주요상권 포함 지표가 전체 폭을 차지한다. 지도는 56vh 높이를 확보하고 주요상권 분석은 반경 분석보다 먼저 이어진다. 기준 안내와 출처 태그처럼 부차적인 정보는 좁은 화면에서 숨기고 핵심 입력, 결과, 필터와 분석을 보존한다. 520px 이하에서는 버튼과 필터가 두 열로 늘어나고 결과 표의 과세 유형 열이 생략된다.

**The Parallel-Then-Sequential Rule.** 데스크톱은 조건·지도·분석을 동시에 보여 주고, 모바일은 같은 순서를 위에서 아래로 풀어낸다. 좁은 화면에서 데스크톱 그리드를 축소하지 않는다.

## Elevation & Depth

이 시스템은 그림자를 거의 사용하지 않는다. 깊이는 심야 바탕, 무광 패널, 상승 표면의 명도 차와 1px 구조선으로 만든다. 포커스는 3px 청색 외곽선, 텍스트 영역은 2px 내부 청색선으로 현재 위치를 분명히 한다. 지도 안내와 컨트롤만 불투명도가 높은 청흑색 오버레이로 지도 위에 뜬다.

**The Flat Control Room Rule.** 정지 상태의 패널과 컨트롤에 낙하 그림자를 추가하지 않는다. 층위는 표면 명도, 경계선과 위치로 설명한다.

## Shapes

형태는 직사각형을 유지하면서 모서리만 부드럽게 정리한다. 큰 패널은 12px, 표 내부 컨테이너와 팝업은 8px, 버튼은 7px, 입력·칩·상태 배지는 6px, 작은 출처 태그는 4px 곡률을 사용한다. 테두리는 대부분 1px이며, 활성 탭만 2px 하단선으로 상태를 드러낸다. 지도 업소는 유일한 원형 요소로, 12px 점과 원형 반경을 사용해 공간 데이터임을 구분한다.

**The Bounded Geometry Rule.** 업무 컨테이너는 얕은 곡률과 선으로 닫는다. 캡슐형 컨트롤이나 과도하게 둥근 카드로 친근함을 연출하지 않는다.

## Components

### Buttons
- **Shape:** 최소 높이 40px의 단단한 직사각형이며 7px 곡률과 9px 15px 내부 여백을 사용한다.
- **Primary:** 관제 청색 면과 심야색 텍스트로 가장 중요한 실행 하나를 표시한다.
- **Hover / Focus:** hover는 같은 계열에서 한 단계 밝거나 강한 표면으로 이동하며 160ms ease-out 전환을 사용한다. focus-visible은 전역 3px 신호 청색 외곽선을 유지한다.
- **Secondary / Quiet / Export:** 보조 버튼은 상승 표면과 강한 구조선, quiet 버튼은 투명 배경, export 버튼은 확인 녹색 쌍을 사용한다.

### Chips
- **Style:** 기본 상태는 상승 표면, 구조선과 보조 텍스트를 사용하며 최소 높이는 36px이다.
- **State:** 선택 상태는 청색 경계, 심층 청색 배경과 밝은 텍스트를 함께 바꾼다. 필터 칩과 반경 선택기가 같은 문법을 공유한다.

### Cards / Containers
- **Corner Style:** 큰 업무 패널은 12px, 내부 표 래퍼와 팝업은 8px 곡률이다.
- **Background:** 무광 패널이 기본이며 입력 본문이나 중첩 요약은 심층 표면으로 내려간다.
- **Shadow Strategy:** 그림자 없이 표면 명도와 1px 선으로만 분리한다.
- **Border:** 기본 구조선을 사용하고 입력·오버레이에는 강한 구조선을 사용한다.
- **Internal Padding:** 밀도에 따라 16–20px를 사용하며 표 셀은 11px 14px다.

### Inputs / Fields
- **Style:** 40px 최소 높이, 심층 청흑색 배경, 강한 구조선, 6px 곡률을 사용한다. 사업자번호 textarea는 고정폭 글꼴과 넉넉한 1.85 행간을 갖는다.
- **Focus:** 전역 외곽선에 더해 textarea는 2px 내부 청색선을 사용한다.
- **Zone Selector:** 행정동과 업종 선택기 사이에 VWorld 주요상권 선택기를 둔다. 전체 지역 또는 개별 경계를 선택하며, 경계 데이터가 없으면 비활성화한다.
- **Error / Disabled:** 비활성 select와 button은 투명도를 낮추고, 오류 결과 행과 로드 오류는 짙은 적색 배경을 사용한다.

### Boundary Toggle
- **Style:** 최소 높이 40px, 심층 표면, 1px 구조선, 6px 곡률과 8px 10px 여백을 사용하는 라벨형 체크 컨트롤이다. 16px 체크박스는 관제 청색 accent-color를 사용한다.
- **State:** 기본으로 선택되어 지도 경계를 표시한다. 체크 해제는 경계 레이어만 숨기고 상권 필터 선택은 유지하며, 경계 데이터가 없으면 비활성화한다.

### Metric Strip
- **Style:** 12px 곡률의 한 컨테이너 안에 76px 높이 지표 다섯 개를 같은 폭으로 나눈다. 12px 라벨 아래 24px 고정폭 값을 표시하며 셀 사이는 1px 구조선으로 구분한다.
- **Content:** 다섯째 셀은 주요상권 경계 내부 업소 수와 전체 대비 비율을 `건수 · 비율` 형식으로 보여 주고, 데이터가 없으면 `미제공`으로 표시한다.
- **Responsive:** 780px 이하에서는 2+2+1 구조로 재배치하며 마지막 셀이 전체 폭을 차지한다.

### Navigation
- **Style:** 헤더 아래의 두 서비스는 48px 높이의 동급 탭이다. 기본 상태는 보조 텍스트, hover는 밝은 텍스트와 미세한 표면 변화, active는 신호 청색 텍스트와 2px 하단선이다. 모바일에서는 두 탭이 같은 폭을 차지한다.

### Status Badges
- **Style:** 28px 최소 높이, 6px 곡률, 12px 굵은 라벨과 1px 의미색 경계를 사용한다.
- **State:** 성공·휴업·폐업·오류·미등록을 전경색, 배경색과 한국어 텍스트의 조합으로 구분한다.

### Data Table
- **Style:** 12px 굵은 머리글은 짙은 상승 표면에 고정되고, 15px 데이터 행은 1px 구분선을 사용한다. 행 hover는 표면을 한 단계 밝힌다.
- **Behavior:** 숫자와 등록번호는 고정폭이며 표는 가로 스크롤을 허용한다. 가장 좁은 화면에서는 덜 중요한 열만 숨긴다.

### Map Workspace
- **Style:** 좌우 레일과 중앙 지도를 한 12px 패널 안에 결합한다. Leaflet 컨트롤, 팝업, 클러스터와 안내 오버레이도 같은 청흑색 표면과 청색 신호를 사용한다.
- **Behavior:** 선택 지점은 청색 원과 반투명 면으로 반경을 표시하고, 하단 안내문이 현재 거리와 필터 기준을 설명한다. 주요상권 폴리곤을 클릭하면 선택기와 분석 패널이 동기화되고 32px 지도 여백, 최대 줌 16으로 경계에 맞춘다.
- **Polygon States:** 기본 경계는 황색 2px 선, 82% 선 불투명도와 6% 채움이다. hover는 비선택 경계의 선을 3px, 채움을 12%로 높인다. selected는 신호 청색 3px 선, 100% 선 불투명도와 관제 청색 18% 채움으로 바뀐다.

### Zone Analysis Panel
- **Style:** 오른쪽 분석 레일의 맨 위에서 반경 분석과 1px 구조선으로 구분된다. 제목 옆 고정폭 배지는 등록 경계 수를 표시하고, 이름은 15px 굵은 제목, 항목명은 12px 보조 텍스트, 값은 12px 고정폭 우측 정렬을 사용한다.
- **Overview State:** 상권을 선택하지 않으면 등록 경계, 경계 내부·외부 업소 수와 경계 갱신일을 네 행으로 보여 준다.
- **Selected State:** 선택한 상권 이름, 면적, 전체 점포, 현재 조건 점포와 상위 세 업종 막대를 보여 준다. 경계 데이터가 없으면 점포·반경 분석만 제공한다는 설명 상태로 바뀐다.

## Do's and Don'ts

### Do:
- **Do** 청색을 주요 실행, 활성 선택, 진행과 지도 분석처럼 조작 의미가 있는 곳에 집중한다.
- **Do** 건수, 코드, 거리, 좌표와 날짜를 고정폭 숫자로 정렬한다.
- **Do** 출처, 기준일, 데이터 제한과 오류를 결과 가까이에 보조 텍스트 또는 의미색 상태로 표시한다.
- **Do** 지도 경계의 default, hover, selected 상태를 색뿐 아니라 선 굵기와 채움 농도로 함께 구분한다.
- **Do** 넓은 화면의 병렬 업무 구조를 모바일에서 입력→결과 또는 필터→지도→분석의 세로 순서로 보존한다.
- **Do** 1px 구조선과 표면 명도 차로 정보 구획을 설명한다.

### Don't:
- **Don't** 그림자, 그라디언트, 유리 효과나 장식용 광택을 추가해 무광 관제 환경을 흐리지 않는다.
- **Don't** 청색을 넓은 장식 면이나 의미 없는 강조에 사용하지 않는다.
- **Don't** 상태색을 텍스트 라벨 없이 단독으로 사용하거나 서로 다른 의미에 재사용하지 않는다.
- **Don't** 숫자 중심 업무 화면에 대형 마케팅 헤드라인, 장식용 서체 또는 과도한 여백을 도입하지 않는다.
- **Don't** 모바일에서 지도와 분석을 축소된 다열 구조로 유지하거나 핵심 데이터 열을 무차별적으로 숨기지 않는다.
