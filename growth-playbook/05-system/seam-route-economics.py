"""Offline illustrative USD economics, NOT Seam financials or a vendor quote.
No API, credentials, network or application imports. Inputs are in this file.
Public observed price is $5/$50 per device-month; eligibility requires confirmation.
Direct TTLock platform fee of zero is an UNVERIFIED sensitivity baseline, not fact.
Shared hardware/import/tax/local-emergency costs excluded from route comparison.
"""
from pathlib import Path
import csv
from math import ceil
BASE=Path(__file__).resolve().parent

def tco(n, months=36, rate=40, direct_hours=240, seam_hours=60,
        direct_maintenance=12, seam_maintenance=4, seam_fee=5,
        direct_fee=0, support_annual=0):
    direct=direct_hours*rate+months*(direct_maintenance*rate+n*direct_fee)
    seam=seam_hours*rate+months*(seam_maintenance*rate+n*seam_fee+support_annual/12)
    return dict(devices=n,months=months,seam_fee_device_month=seam_fee,
        hypothetical_direct_fee_device_month=direct_fee,extra_seam_support_annual=support_annual,
        direct_total_usd=round(direct,2),seam_total_usd=round(seam,2),
        seam_saving_vs_direct_usd=round(direct-seam,2),
        quote_status='illustrative_not_a_quote')

def write_csv(name, rows):
    with (BASE/name).open('w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)

def main():
    rows=[]
    for n in [20,100,500,2000]:
        rows.append(dict(scenario='unit_list_price_reference',**tco(n)))
    rows += [dict(scenario='high_traffic_reference',**tco(20,seam_fee=50)),
             dict(scenario='premium_support_reference',**tco(100,support_annual=20000)),
             dict(scenario='direct_fee_sensitivity',**tco(100,direct_fee=1)),
             dict(scenario='direct_simple_scope',**tco(100,direct_hours=100,direct_maintenance=4)),
             dict(scenario='seam_harder_scope',**tco(100,seam_hours=180,seam_maintenance=10))]
    write_csv('seam-route-tco.csv',rows)
    assert tco(100)['direct_total_usd']==26880
    assert tco(100)['seam_total_usd']==26160
    assert tco(104)['seam_saving_vs_direct_usd']==0
    margin=[]
    for name,price,fee in [('resell_low',3,5),('resell_mid',8,5),
                            ('resell_higher',12,5),('resell_high_traffic',12,50),
                            ('byo_seam_workflow_only',3,0)]:
        infra=.75; support=.5; contribution=price-fee-infra-support
        margin.append(dict(scenario=name,our_monthly_price_usd=price,
            upstream_fee_paid_by_us=fee,our_infra_usd=infra,our_support_usd=support,
            contribution_before_fixed_usd=contribution,
            contribution_rate=round(contribution/price,6),
            contract_status='resale_not_authorized' if fee else 'partner_pays_seam_separately'))
    write_csv('seam-route-margins.csv',margin)
    assert margin[0]['contribution_before_fixed_usd']==-3.25
    assert margin[-1]['contribution_before_fixed_usd']==1.75
    hypothetical=[]
    for net_price in [3,5,10]:
        for contribution_rate in [.6,.8]:
            hypothetical.append(dict(scenario='hypothetical_api_company_NOT_Seam_actuals',
                fixed_annual_usd=6000000,net_device_month_usd=net_price,
                assumed_contribution_rate=contribution_rate,
                required_annual_average_paying_devices=ceil(6000000/(12*net_price*contribution_rate))))
    write_csv('seam-hypothetical-breakeven.csv',hypothetical)
    assert hypothetical[3]['required_annual_average_paying_devices']==125000
    for r in rows:print(r['scenario'],r['devices'],r['direct_total_usd'],r['seam_total_usd'],r['seam_saving_vs_direct_usd'])
    print('PASS: 9 TCO scenarios, 5 contribution cases, 6 hypothetical break-even cases. No vendor/physical tests run.')
if __name__=='__main__':main()
