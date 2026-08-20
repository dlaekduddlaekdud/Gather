-- 좌석 정원을 DB에서 보장한다.
-- 앱에서 count 후 insert 하는 구조는 두 요청이 count를 동시에 통과하면 정원을 넘는다.

CREATE OR REPLACE FUNCTION join_carpool(p_offer_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_seats int;
  v_taken int;
BEGIN
  -- carpool_offers 행을 FOR UPDATE 하지 않는 이유:
  -- RLS 활성 테이블에서 SELECT ... FOR UPDATE 는 UPDATE 정책까지 통과해야 한다.
  -- carpool_offers 에 UPDATE 정책을 추가하면 좌석 수 변경 권한이 함께 열린다.
  -- offer 단위 advisory lock 으로 같은 목적을 달성하고 권한 범위는 그대로 둔다.
  PERFORM pg_advisory_xact_lock(hashtext(p_offer_id::text));

  SELECT seats INTO v_seats
    FROM carpool_offers
   WHERE id = p_offer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CARPOOL_OFFER_NOT_FOUND';
  END IF;

  SELECT count(*) INTO v_taken
    FROM carpool_passengers
   WHERE offer_id = p_offer_id
     AND status IN ('pending', 'confirmed');

  IF v_taken >= v_seats THEN
    RAISE EXCEPTION 'CARPOOL_FULL';
  END IF;

  INSERT INTO carpool_passengers (offer_id, user_id, status)
  VALUES (p_offer_id, auth.uid(), 'pending');
END;
$$;

-- 승인 시점에도 정원을 검사한다. 신청만 막으면 승인 단계에서 초과가 가능하다.
CREATE OR REPLACE FUNCTION confirm_passenger(p_passenger_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_offer_id  uuid;
  v_seats     int;
  v_confirmed int;
BEGIN
  SELECT co.id, co.seats INTO v_offer_id, v_seats
    FROM carpool_passengers cp
    JOIN carpool_offers co ON co.id = cp.offer_id
   WHERE cp.id = p_passenger_id
     AND co.driver_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_CARPOOL_DRIVER';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_offer_id::text));

  SELECT count(*) INTO v_confirmed
    FROM carpool_passengers
   WHERE offer_id = v_offer_id
     AND status = 'confirmed';

  IF v_confirmed >= v_seats THEN
    RAISE EXCEPTION 'CARPOOL_FULL';
  END IF;

  UPDATE carpool_passengers
     SET status = 'confirmed'
   WHERE id = p_passenger_id;
END;
$$;

GRANT EXECUTE ON FUNCTION join_carpool(uuid)      TO authenticated;
GRANT EXECUTE ON FUNCTION confirm_passenger(uuid) TO authenticated;

-- 탑승 상태 전이는 운전자만 가능하다.
-- 기존 정책은 user_id = auth.uid() 를 허용해 신청자가 자기 신청을 confirmed 로 바꿀 수 있었다.
-- 취소는 DELETE 정책(본인 허용)으로 처리되므로 본인의 UPDATE 권한은 필요 없다.
DROP POLICY IF EXISTS "탑승 상태 수정 (운전자 or 본인)" ON carpool_passengers;
DROP POLICY IF EXISTS "탑승 상태 수정 (운전자)" ON carpool_passengers;

CREATE POLICY "탑승 상태 수정 (운전자)" ON carpool_passengers FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM carpool_offers co
      WHERE co.id = carpool_passengers.offer_id
        AND co.driver_id = auth.uid()
    )
  );