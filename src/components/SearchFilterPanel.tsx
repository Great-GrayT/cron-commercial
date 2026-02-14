"use client";

import "./SearchFilterPanel.css";
import { useState, useMemo, useRef, useEffect } from "react";
import {
  Search,
  X,
  ChevronDown,
  Filter,
  Trash2,
  Building2,
  TrendingUp,
  Briefcase,
  Award,
  Key,
  Code,
  Zap,
  Globe,
  MapPin,
  Map,
  Navigation,
  UserCircle,
  Folder,
  Clock,
  GraduationCap
} from "lucide-react";

interface ActiveFilters {
  industry: string[];
  certificate: string[];
  seniority: string[];
  location: string[];
  company: string[];
  keyword: string[];
  country: string[];
  city: string[];
  software: string[];
  programmingSkill: string[];
  yearsExperience: string[];
  academicDegree: string[];
  region: string[];
  roleType: string[];
  roleCategory: string[];
}

interface FilterOption {
  value: string;
  count: number;
}

interface FilterCategory {
  key: keyof ActiveFilters;
  label: string;
  icon: React.ElementType;
}

interface SearchFilterPanelProps {
  activeFilters: ActiveFilters;
  setActiveFilters: (filters: ActiveFilters) => void;
  availableOptions: Record<keyof ActiveFilters, FilterOption[]>;
  textSearch: string;
  setTextSearch: (search: string) => void;
}

const FILTER_CATEGORIES: FilterCategory[] = [
  { key: 'industry', label: 'Industry', icon: Building2 },
  { key: 'seniority', label: 'Seniority', icon: TrendingUp },
  { key: 'company', label: 'Company', icon: Briefcase },
  { key: 'certificate', label: 'Certificates', icon: Award },
  { key: 'keyword', label: 'Keywords', icon: Key },
  { key: 'software', label: 'Software', icon: Code },
  { key: 'programmingSkill', label: 'Languages', icon: Zap },
  { key: 'country', label: 'Country', icon: Globe },
  { key: 'city', label: 'City', icon: MapPin },
  { key: 'region', label: 'Region', icon: Map },
  { key: 'location', label: 'Location', icon: Navigation },
  { key: 'roleType', label: 'Role Type', icon: UserCircle },
  { key: 'roleCategory', label: 'Category', icon: Folder },
  { key: 'yearsExperience', label: 'Experience', icon: Clock },
  { key: 'academicDegree', label: 'Degree', icon: GraduationCap },
];

export function SearchFilterPanel({
  activeFilters,
  setActiveFilters,
  availableOptions,
  textSearch,
  setTextSearch,
}: SearchFilterPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [openDropdown, setOpenDropdown] = useState<keyof ActiveFilters | null>(null);
  const [dropdownSearches, setDropdownSearches] = useState<Record<string, string>>({});
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpenDropdown(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Count total active filters
  const activeFilterCount = useMemo(() => {
    return Object.values(activeFilters).reduce((sum, arr) => sum + arr.length, 0);
  }, [activeFilters]);

  // Toggle a filter value
  const toggleFilter = (category: keyof ActiveFilters, value: string) => {
    setActiveFilters({
      ...activeFilters,
      [category]: activeFilters[category].includes(value)
        ? activeFilters[category].filter((v) => v !== value)
        : [...activeFilters[category], value],
    });
  };

  // Remove a specific filter
  const removeFilter = (category: keyof ActiveFilters, value: string) => {
    setActiveFilters({
      ...activeFilters,
      [category]: activeFilters[category].filter((v) => v !== value),
    });
  };

  // Clear all filters
  const clearAllFilters = () => {
    setActiveFilters({
      industry: [],
      certificate: [],
      seniority: [],
      location: [],
      company: [],
      keyword: [],
      country: [],
      city: [],
      software: [],
      programmingSkill: [],
      yearsExperience: [],
      academicDegree: [],
      region: [],
      roleType: [],
      roleCategory: [],
    });
    setTextSearch('');
  };

  // Get filtered options for a dropdown (LIMITED to prevent UI freeze)
  const getFilteredOptions = (category: keyof ActiveFilters): FilterOption[] => {
    const search = dropdownSearches[category]?.toLowerCase() || '';
    const options = availableOptions[category] || [];

    // Limit to prevent rendering too many DOM elements
    const MAX_OPTIONS = 150;

    let filtered = options;
    if (search) {
      filtered = options.filter(opt =>
        opt.value.toLowerCase().includes(search)
      );
    }

    // Only return top N options to prevent UI freeze
    return filtered.slice(0, MAX_OPTIONS);
  };

  // Render a single filter dropdown
  const renderFilterDropdown = (category: FilterCategory) => {
    const isOpen = openDropdown === category.key;
    const filteredOptions = getFilteredOptions(category.key);
    const selectedCount = activeFilters[category.key].length;
    const IconComponent = category.icon;

    return (
      <div key={category.key} className="filter-dropdown-container">
        <button
          className={`filter-dropdown-trigger ${selectedCount > 0 ? 'active' : ''}`}
          onClick={() => setOpenDropdown(isOpen ? null : category.key)}
        >
          <IconComponent size={14} className="filter-icon" />
          <span className="filter-label">{category.label}</span>
          {selectedCount > 0 && (
            <span className="filter-count">{selectedCount}</span>
          )}
          <ChevronDown size={14} className={`chevron ${isOpen ? 'open' : ''}`} />
        </button>

        {isOpen && (
          <div className="filter-dropdown-menu">
            {/* Search within dropdown */}
            <div className="filter-dropdown-search">
              <Search size={12} />
              <input
                type="text"
                placeholder={`Search ${category.label.toLowerCase()}...`}
                value={dropdownSearches[category.key] || ''}
                onChange={(e) => setDropdownSearches({
                  ...dropdownSearches,
                  [category.key]: e.target.value
                })}
                onClick={(e) => e.stopPropagation()}
              />
            </div>

            {/* Options list */}
            <div className="filter-dropdown-options">
              {filteredOptions.length === 0 ? (
                <div className="filter-no-results">No results found</div>
              ) : (
                filteredOptions.map((option) => (
                  <label
                    key={option.value}
                    className="filter-option"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={activeFilters[category.key].includes(option.value)}
                      onChange={() => toggleFilter(category.key, option.value)}
                    />
                    <span className="filter-option-label">{option.value}</span>
                    <span className="filter-option-count">{option.count}</span>
                  </label>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  // Render active filter badges
  const renderActiveFilterBadges = () => {
    const badges: JSX.Element[] = [];

    (Object.keys(activeFilters) as Array<keyof ActiveFilters>).forEach((category) => {
      activeFilters[category].forEach((value) => {
        const categoryInfo = FILTER_CATEGORIES.find(c => c.key === category);
        const IconComponent = categoryInfo?.icon;
        badges.push(
          <div key={`${category}-${value}`} className="filter-badge">
            {IconComponent && <IconComponent size={12} className="filter-badge-icon" />}
            <span className="filter-badge-text">{value}</span>
            <button
              className="filter-badge-remove"
              onClick={() => removeFilter(category, value)}
              aria-label={`Remove ${value} filter`}
            >
              <X size={12} />
            </button>
          </div>
        );
      });
    });

    return badges;
  };

  return (
    <div className="search-filter-panel" ref={dropdownRef}>
      {/* Main Search Bar and Toggle */}
      <div className="search-filter-header">
        <div className="search-input-container">
          <Search size={16} />
          <input
            type="text"
            placeholder="Search jobs, companies, titles..."
            value={textSearch}
            onChange={(e) => setTextSearch(e.target.value)}
            className="search-input"
          />
          {textSearch && (
            <button
              className="search-clear"
              onClick={() => setTextSearch('')}
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>

        <button
          className={`filter-toggle-btn ${isExpanded ? 'active' : ''}`}
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <Filter size={14} />
          <span>FILTERS</span>
          {activeFilterCount > 0 && (
            <span className="filter-total-count">{activeFilterCount}</span>
          )}
          <ChevronDown size={14} className={`chevron ${isExpanded ? 'open' : ''}`} />
        </button>

        {activeFilterCount > 0 && (
          <button
            className="clear-all-btn"
            onClick={clearAllFilters}
          >
            <Trash2 size={14} />
            <span>CLEAR ALL</span>
          </button>
        )}
      </div>

      {/* Expanded Filter Section */}
      {isExpanded && (
        <div className="filter-section">
          <div className="filter-dropdowns-grid">
            {FILTER_CATEGORIES.map(renderFilterDropdown)}
          </div>
        </div>
      )}

      {/* Active Filter Badges */}
      {activeFilterCount > 0 && (
        <div className="active-filters-section">
          <div className="active-filters-label">Active Filters:</div>
          <div className="active-filters-badges">
            {renderActiveFilterBadges()}
          </div>
        </div>
      )}
    </div>
  );
}
