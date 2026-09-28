"""Illustrative USD planning, not quotes or orders. Standard library only.
Prepaid export replaces historical credit-term cases. No imports of application code.
Net accepted units exclude samples/replacements/channel stock. All planned units accepted.
M-2 deposit before supplier advance; M-1 supplier completion paid BEFORE buyer balance;
balance cleared before shipment. M acceptance. No receivables or VAT modeled.
10% of revenue of latest 3 accepted months held as additional treasury buffer, not expense.
"""
import csv
from pathlib import Path
BASE = Path(__file__).resolve().parent
UNITS = [0, 0, 50, 150, 400, 900, 1500, 2500, 4000, 5500, 6500, 8500]
ASP = (6000*99 + 12000*89 + 12000*79)/30000
FIXED, LAUNCH, VARIABLE = 40000, 100000, 11

def run(name, deposit=.5, cost=50, scale=1):
    units = [round(n*scale) for n in UNITS]
    def u(m): return units[m-1] if 1 <= m <= 12 else 0
    cash, low, free_low, rows = 0., 0., 0., []
    buffer = 0.
    for m in range(0, 16):
        receipts_d = deposit*ASP*u(m+2)
        receipts_b = (1-deposit)*ASP*u(m+1)
        advance, completion = .3*cost*u(m+2), .7*cost*u(m+1)
        operating = (FIXED if 1 <= m <= 12 else 0) + VARIABLE*u(m)
        launch = LAUNCH if m == 0 else 0
        start = cash
        # Conservative within-month ordering: overhead, deposits, supplier costs, balance.
        for delta in [-launch-operating, receipts_d, -advance, -completion, receipts_b]:
            cash += delta
            low = min(low, cash)
            free_low = min(free_low, cash-buffer)
        buffer = .1*ASP*sum(u(k) for k in range(m-2, m+1))
        free_low = min(free_low, cash-buffer)
        # Remaining work required for deposits received on future accepted cohorts.
        unearned = ASP*u(m+1) + deposit*ASP*u(m+2)
        rows.append([m,u(m),ASP*u(m),receipts_d,receipts_b,advance,completion,
                     operating,launch,cash-start,cash,buffer,cash-buffer,unearned])
    contribution=sum(units)*(ASP-cost-VARIABLE)
    profit=contribution-FIXED*12-LAUNCH
    assert abs(cash-profit)<1e-6
    assert abs(sum(r[3]+r[4] for r in rows)-sum(units)*ASP)<1e-6
    assert abs(sum(r[5]+r[6] for r in rows)-sum(units)*cost)<1e-6
    assert buffer == 0
    with (BASE/f'prepaid-export-cash-{name}.csv').open('w',newline='') as f:
        w=csv.writer(f)
        w.writerow(['month','net_accepted_units','revenue_usd','buyer_deposit_usd',
            'buyer_balance_before_shipping_usd','supplier_advance_usd','supplier_completion_usd',
            'operating_and_variable_usd','launch_usd','net_cash_usd','unfunded_cash_usd',
            'additional_liquidity_buffer_usd','cash_after_buffer_usd','unearned_customer_cash_usd'])
        w.writerows([[round(x,2) if isinstance(x,float) else x for x in r] for r in rows])
    return [name,sum(units),ASP,sum(units)*ASP,contribution,profit,-low,-free_low]

if __name__ == '__main__':
    assert sum(UNITS)==30000
    scenarios=[run('deposit50'),run('deposit30',deposit=.3),
               run('cost_up20',cost=60),run('volume12000',scale=.4)]
    with (BASE/'prepaid-export-scenarios.csv').open('w',newline='') as f:
        w=csv.writer(f)
        w.writerow(['scenario','net_units','net_asp_usd','revenue_usd','contribution_usd',
                    'planning_surplus_before_tax_usd','peak_event_cash_gap_usd',
                    'peak_gap_with_additional_buffer_usd'])
        for row in scenarios:
            row=[round(x,2) if isinstance(x,float) else x for x in row]
            w.writerow(row)
            print(row)
    print('PASS: receipts, supplier costs, terminal cash and buffer reconciled.')
