#!/bin/bash
# gql.sh MINUTES_BACK script
S=$(date -u -d "-$1 min" +%FT%TZ); E=$(date -u +%FT%TZ)
Q="{viewer{accounts(filter:{accountTag:\\\"$CLOUDFLARE_ACCOUNT_ID\\\"}){workersInvocationsAdaptive(limit:200,filter:{datetime_geq:\\\"$S\\\",datetime_leq:\\\"$E\\\",scriptName:\\\"${2:-formheartbeat-loadtest}\\\"}){sum{requests errors subrequests} quantiles{cpuTimeP50 cpuTimeP99 cpuTimeP999 wallTimeP99} dimensions{status datetimeMinute}}}}}"
curl -s https://api.cloudflare.com/client/v4/graphql -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'content-type: application/json' -d "{\"query\":\"$Q\"}"
