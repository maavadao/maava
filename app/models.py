from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime


class ScrapeJobResponse(BaseModel):
    id: str
    status: str
    skills_found: int
    error_message: Optional[str] = None
    started_at: datetime
    completed_at: Optional[datetime] = None


class SkillItem(BaseModel):
    id: str
    skill_id: str
    name: str
    description: Optional[str] = None
    category: str
    installs: int
    source: str
    source_url: Optional[str] = None
    is_installed: bool
    created_at: datetime
    updated_at: datetime


class SkillsListResponse(BaseModel):
    items: List[SkillItem]
    total: int
    page: int
    page_size: int
    has_next: bool
