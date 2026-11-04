# 시험용 고정 응답(합성)

- 모두 **합성 데이터**다. 종목코드 `9999xx`·티커 `TSTA`는 실제 종목이 아니다.
- 필드 이름은 공식 자료 기준: KIS 공식 예제 저장소(`koreainvestment/open-trading-api`, examples_llm `chk_*.py`의 열 이름), Alpaca 공식 API 문서(StockSnapshots·StockBars·Get an Asset).
- `koreaexim-badkey.json`은 2026-11-04 실제 엔드포인트에 잘못된 키로 요청해 받은 응답 그대로다. `koreaexim-ok.json`의 정상 응답 모양(`result: 1`, 콤마 숫자)은 키가 없어 **직접 확인 못 함**(추정).
- M4 `kis-ksdinfo-dividend.json`(KIS 예제 `ksdinfo_dividend`의 output1 열 이름)·`alpaca-corporate-actions.json`(Alpaca 문서 Corporate actions의 cash_dividends 필드)도 합성이다. KIS 배당 응답의 **날짜 표기 형식은 확인 못 해** 해석기가 `YYYYMMDD`·`YYYY/MM/DD`·`YYYY-MM-DD`를 모두 받는다.
