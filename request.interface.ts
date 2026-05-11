export enum CauseTag {
  Travel = "Travel",
  Fees = "Fees",
  Equipment = "Equipment",
  Supplies = "Supplies",
  Facilities = "Facilities",
  Scholarships = "Scholarships",
  Event = "Event",
  Tournament = "Tournament",
  Other = "Other",
}

export interface CauseStatementRequest {
  tags: CauseTag[]
  template: {
    replaceable_attributes: {
      FUNDRAISING_EVENT_NAME?: string // Entered by user
      FUNDRAISER_ORGANIZATION_NAME?: string // Entered by user
      FUNDRAISER_ORGANIZATION_TYPE?: string // Name from taxonomy data
      FUNDRAISER_ACTIVITY?: string // Name from taxonomy data related to the FUNDRAISER_ORGANIZATION_TYPE
      FUNDRAISER_AFFILIATION?: string // Name from taxonomy data related to the FUNDRAISER_ACTIVITY
    }
  }
}