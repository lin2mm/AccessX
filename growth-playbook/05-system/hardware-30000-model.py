# HISTORICAL CREDIT-TERM COMPARISON ONLY. Current policy: prepaid-export-model.py
"""Planning only. USD; no external packages, quotes, orders, or actual sales.
Run from this directory or elsewhere: python hardware-30000-model.py
Cash timing approximates net accepted units; refund reserve is extra, not modeled.
"""
import csv
from pathlib import Path
BASE = Path(__file__).resolve().parent
UNITS = [0, 0, 50, 150, 400, 900, 1500, 2500, 4000, 5500, 6500, 8500]
ASP = (8000 * 99 + 10000 * 89 + 12000 * 79) / 30000
# Blended mix is assumed constant monthly; net supplier price after channel discount.
LANDED = 50.0  # illustrative factory 40 + freight/tariff 10; unquoted
VARIABLE = 11.0  # warranty reserve 6 + basic device services reserve 3 + payment 2
FIXED = 40000.0  # incremental hardware-line monthly team/operations allocation
ONEOFF = 100000.0  # illustrative launch engineering/tooling/test allowance; not a quote

def cash_ledger(units, deposit, balance_lag, landed=LANDED):
    cumulative = 0.0
    rows = []
    def u(month): return units[month-1] if 1 <= month <= len(units) else 0
    # M0 captures deposits/payments before the modeled sales year; actual R&D may precede M0.
    for month in range(0, 15):
        receipts = deposit * ASP * u(month+1) + (1-deposit) * ASP * u(month-balance_lag)
        supplier = .3 * landed * u(month+2) + .7 * landed * u(month+1)
        reserve = VARIABLE * u(month)
        overhead = FIXED if 1 <= month <= 12 else 0
        launch = ONEOFF if month == 1 else 0
        net = receipts-supplier-reserve-overhead-launch
        cumulative += net
        rows.append([month,u(month),round(ASP*u(month),2),round(receipts,2),round(supplier,2),round(reserve,2),overhead,launch,round(net,2),round(cumulative,2)])
    return rows

assert sum(UNITS) == 30000
headers=['month','net_accepted_units','net_hardware_revenue_usd','cash_receipts_usd','supplier_prepay_usd','variable_cost_reserve_usd','fixed_cost_usd','launch_cost_usd','net_cash_usd','cumulative_unfunded_cash_usd']
summary=[]
for label,deposit,lag,landed in [('negotiated_deposit',.3,1,50),('no_deposit_net60',0,2,50),('cost_up20_net60',0,2,60)]:
    rows=cash_ledger(UNITS,deposit,lag,landed)
    with (BASE/f'hardware-30000-cash-{label}.csv').open('w',newline='') as f:
        w=csv.writer(f);w.writerow(headers);w.writerows(rows)
    peak=max(0,-min(r[-1] for r in rows))
    contribution=sum(UNITS)*(ASP-landed-VARIABLE)
    profit=contribution-FIXED*12-ONEOFF
    assert abs(rows[-1][-1]-profit)<.02
    summary.append([label,30000,round(ASP,4),round(ASP*30000,2),round(contribution,2),round(profit,2),round(peak,2)])
with (BASE/'hardware-30000-scenarios.csv').open('w',newline='') as f:
    w=csv.writer(f);w.writerow(['scenario','net_units','net_asp_usd','revenue_usd','contribution_before_fixed_usd','planning_surplus_before_tax_usd','peak_unfunded_cash_gap_usd']);w.writerows(summary)
for r in summary: print(r)
print('Counts and cash reconciliation verified. Actual free cash flow/profit require accounting review.')
