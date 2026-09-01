# Seminole County property pipeline

Collects public Seminole County, Florida records and keeps them current so the [Roofing CRM](https://github.com/prismteam-ai/roofing-crm) can search them.

| | |
| --- | --- |
| **Live site** | https://d1gfdmw7ud0jxj.cloudfront.net |
| **Used by** | [Roofing CRM](https://github.com/prismteam-ai/roofing-crm) |
| **Role** | Data side — the CRM is the map and lead list |

## What it does

1. Gather county property records, permit history, and contractor reputation where it exists.
2. Publish a searchable set the CRM reads.
3. Show coverage on a live page so you can see what landed.

About **181,000 parcels** are in the published roll.

## Features

| Feature | What you can do |
| --- | --- |
| Run summary | See what has loaded — properties, permits, contractors, incomplete sources |
| Parcel search | Look up a property by address or parcel id |
| Radius search | Nearby parcels by centre and distance (no sales filters) |
| Owner view | Other parcels the same owner holds in the county |
| Published roll | Addresses, owners, values, year built, coordinates |

### Run summary

| Shown | Purpose |
| --- | --- |
| Sources loaded | Properties, permits, contractors |
| Incomplete sources | Anything still in progress |
| Counts + last collected | Coverage without opening the CRM |

Sources that never loaded stay off the main list.

### Parcel search

| Step | Result |
| --- | --- |
| Search by address or parcel id | Matching properties |
| Open a parcel | Ownership, value, year built, permit history for that lot |

### Radius search

Same idea as the CRM map, without the sales filters.

| Input | Result |
| --- | --- |
| Centre + distance | Nearby parcels |

Use it to confirm coordinates are published and a neighbourhood is in the data.

### Owner view

Open an owner from a parcel → see the other parcels they hold in the county.

### What gets collected

| Source | What lands in the roll |
| --- | --- |
| County appraisal | Base property list the CRM searches |
| Permit history | Type of work, dates, contractor, status when checked |
| BBB | Rating matched to a contractor name, when a rating exists |
