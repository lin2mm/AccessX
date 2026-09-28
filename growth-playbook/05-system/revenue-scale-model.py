"""Conditional annual revenue architecture, RMB excluding VAT. Not a forecast.
Hardware units are net accepted units, not installed base or replacement shipments.
Software volume is annual AVERAGE paying endpoints, not December active count.
Per-endpoint, partner license, and service fees cover different deliverables.
This is NOT a working-capital model or audited P&L. All costs are assumptions.
"""
import csv
import math
from pathlib import Path
BASE=Path(__file__).resolve().parent
SMALL=dict(name='rmb100m_blended',units=120000,asp=600,hardware_unit_cost=420,
    paid_average=100000,monthly=15,software_unit_month_cost=4.5,
    partners=0,license_annual=0,license_cost_annual=0,
    projects=1000,project_price=10000,project_cost=7000,fixed=25000000)
LARGE=dict(name='rmb1b_blended',units=1000000,asp=650,hardware_unit_cost=455,
    paid_average=1000000,monthly=20,software_unit_month_cost=5,
    partners=200,license_annual=300000,license_cost_annual=120000,
    projects=5000,project_price=10000,project_cost=7500,fixed=230000000)

def calculate(d):
    hw=d['units']*d['asp'];saas=d['paid_average']*d['monthly']*12
    licenses=d['partners']*d['license_annual'];services=d['projects']*d['project_price']
    direct=d['units']*d['hardware_unit_cost']+d['paid_average']*d['software_unit_month_cost']*12+d['partners']*d['license_cost_annual']+d['projects']*d['project_cost']
    revenue=hw+saas+licenses+services
    contribution=revenue-direct
    return dict(scenario=d['name'],hardware_net_units=d['units'],hardware_asp_rmb=d['asp'],
        annual_average_paying_endpoints=d['paid_average'],hardware_revenue_rmb=hw,
        software_revenue_rmb=saas,partner_license_revenue_rmb=licenses,
        service_revenue_rmb=services,total_annual_revenue_rmb=revenue,
        assumed_direct_cost_rmb=direct,contribution_before_fixed_rmb=contribution,
        assumed_fixed_rmb=d['fixed'],planning_surplus_before_tax_rmb=contribution-d['fixed'],
        target_met=revenue>=(1000000000 if d['units']==1000000 else 100000000))

def main():
    scenarios=[SMALL,LARGE,dict(SMALL,name='rmb100m_price_down15',asp=510),
        dict(SMALL,name='rmb100m_paid_half',paid_average=50000),
        dict(LARGE,name='rmb1b_price_down15',asp=552.5),
        dict(LARGE,name='rmb1b_paid_half',paid_average=500000)]
    rows=[calculate(s) for s in scenarios]
    assert rows[0]['total_annual_revenue_rmb']==100000000
    assert rows[1]['total_annual_revenue_rmb']==1000000000
    for row in rows:
        assert row['total_annual_revenue_rmb']-row['assumed_direct_cost_rmb']-row['assumed_fixed_rmb']==row['planning_surplus_before_tax_rmb']
    with (BASE/'revenue-scale-scenarios.csv').open('w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)
    with (BASE/'revenue-scale-hardware-only.csv').open('w',newline='') as f:
        w=csv.writer(f);w.writerow(['annual_target_rmb','net_asp_rmb','required_net_accepted_units'])
        for target in [100000000,1000000000]:
            for asp in [300,600,1000]:w.writerow([target,asp,math.ceil(target/asp)])
    for row in rows:print(row)
    print('PASS targets and contribution reconciliation. No cash funding conclusion implied.')
if __name__=='__main__':main()
