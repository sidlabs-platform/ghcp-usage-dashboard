"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { DEFAULT_DATE_RANGE_DAYS } from "@/lib/constants";

interface DateRangeContextType {
  days: number;
  setDays: (days: number) => void;
}

const DateRangeContext = createContext<DateRangeContextType>({
  days: DEFAULT_DATE_RANGE_DAYS,
  setDays: () => {},
});

export function DateRangeProvider({ children }: { children: ReactNode }) {
  const [days, setDays] = useState(DEFAULT_DATE_RANGE_DAYS);
  return (
    <DateRangeContext.Provider value={{ days, setDays }}>
      {children}
    </DateRangeContext.Provider>
  );
}

export function useDateRange() {
  return useContext(DateRangeContext);
}
