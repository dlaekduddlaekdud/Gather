'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'

const carpoolOfferSchema = z.object({
  departure: z.string().min(1, '출발지를 입력하세요'),
  seats: z.number().int().min(1).max(8, '좌석은 1~8석 사이여야 합니다'),
  note: z.string().optional(),
})

export type CarpoolActionResult = {
  error?: string
}

export async function createCarpoolOffer(
  eventId: string,
  formData: FormData
): Promise<CarpoolActionResult> {
  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims()

  if (!data?.claims) {
    redirect('/auth/login')
  }

  const userId = data.claims.sub

  const parsed = carpoolOfferSchema.safeParse({
    departure: formData.get('departure'),
    seats: Number(formData.get('seats')),
    note: formData.get('note') || undefined,
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0].message }
  }

  const { error } = await supabase.from('carpool_offers').insert({
    event_id: eventId,
    driver_id: userId,
    ...parsed.data,
  })

  if (error) {
    return { error: '카풀 제안 등록에 실패했습니다.' }
  }

  revalidatePath(`/events/${eventId}/carpool`)
  return {}
}

export async function joinCarpool(eventId: string, offerId: string): Promise<CarpoolActionResult> {
  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims()

  if (!data?.claims) {
    redirect('/auth/login')
  }

  // 좌석 검사와 삽입을 DB 함수 안에서 처리한다.
  // 앱에서 조회 후 삽입하면 두 요청이 조회를 동시에 통과해 정원을 넘길 수 있다.
  const { error } = await supabase.rpc('join_carpool', { p_offer_id: offerId })

  if (error) {
    if (error.message.includes('CARPOOL_FULL')) {
      return { error: '잔여 좌석이 없습니다.' }
    }
    if (error.message.includes('CARPOOL_OFFER_NOT_FOUND')) {
      return { error: '카풀 정보를 찾을 수 없습니다.' }
    }
    if (error.code === '23505') {
      return { error: '이미 신청한 카풀입니다.' }
    }
    return { error: '탑승 신청에 실패했습니다.' }
  }

  revalidatePath(`/events/${eventId}/carpool`)
  return {}
}

export async function leaveCarpool(eventId: string, offerId: string): Promise<CarpoolActionResult> {
  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims()

  if (!data?.claims) {
    redirect('/auth/login')
  }

  const userId = data.claims.sub

  const { error } = await supabase
    .from('carpool_passengers')
    .delete()
    .eq('offer_id', offerId)
    .eq('user_id', userId)

  if (error) {
    return { error: '탑승 취소에 실패했습니다.' }
  }

  revalidatePath(`/events/${eventId}/carpool`)
  return {}
}

export async function confirmPassenger(
  eventId: string,
  passengerId: string
): Promise<CarpoolActionResult> {
  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims()

  if (!data?.claims) {
    redirect('/auth/login')
  }

  // 운전자 확인과 좌석 검사를 DB 함수 안에서 처리한다.
  const { error } = await supabase.rpc('confirm_passenger', { p_passenger_id: passengerId })

  if (error) {
    if (error.message.includes('CARPOOL_FULL')) {
      return { error: '좌석이 모두 찼습니다.' }
    }
    if (error.message.includes('NOT_CARPOOL_DRIVER')) {
      return { error: '운전자만 승인할 수 있습니다.' }
    }
    return { error: '탑승 확인에 실패했습니다.' }
  }

  revalidatePath(`/events/${eventId}/carpool`)
  return {}
}

export async function rejectPassenger(
  eventId: string,
  passengerId: string
): Promise<CarpoolActionResult> {
  const supabase = await createClient()
  const { data } = await supabase.auth.getClaims()

  if (!data?.claims) {
    redirect('/auth/login')
  }

  const { error } = await supabase
    .from('carpool_passengers')
    .update({ status: 'rejected' })
    .eq('id', passengerId)

  if (error) {
    return { error: '탑승 거절에 실패했습니다.' }
  }

  revalidatePath(`/events/${eventId}/carpool`)
  return {}
}
