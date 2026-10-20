-- Atomic Slot Reservation Script
-- Enforces both minimum delay between emails and per-sender hourly limits
-- KEYS[1] = slot key e.g. slot:{<senderId>}
-- ARGV[1] = nowMs
-- ARGV[2] = minDelayMs
-- ARGV[3] = hourlyLimit
-- ARGV[4] = windowMs (3600000)
-- ARGV[5] = counterKeyPrefix e.g. rl:{<senderId>}:
-- ARGV[6] = counterTtlSec (10800)
-- ARGV[7] = maxLookaheadWindows (72)

local last = tonumber(redis.call('GET', KEYS[1]) or '0')
local now = tonumber(ARGV[1])
local delay = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local windowMs = tonumber(ARGV[4])
local maxLookahead = tonumber(ARGV[7])

local baseWindow = math.floor(now / windowMs)
local maxWindow = baseWindow + maxLookahead

local t = math.max(now, last + delay)
local limitHit = 0
local firstFullWindow = -1

-- Check if current base window already reached its hourly quota
local baseCount = tonumber(redis.call('GET', ARGV[5] .. baseWindow) or '0')
if baseCount >= limit then
  limitHit = 1
  firstFullWindow = baseWindow
end

while true do
  local w = math.floor(t / windowMs)
  if w > maxWindow then
    break
  end

  local key = ARGV[5] .. w
  local c = tonumber(redis.call('GET', key) or '0')
  if c < limit then
    redis.call('INCR', key)
    redis.call('EXPIRE', key, tonumber(ARGV[6]))
    redis.call('SET', KEYS[1], t, 'PX', windowMs * 48)
    return { t, limitHit, w, c + 1, firstFullWindow }
  end

  if limitHit == 0 then
    limitHit = 1
    firstFullWindow = w
  end
  t = (w + 1) * windowMs -- jump to beginning of next hour window
end

return { -1, limitHit, -1, -1, firstFullWindow }
