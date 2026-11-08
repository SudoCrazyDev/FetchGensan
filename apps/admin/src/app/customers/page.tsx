'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { humanizeError } from '@fetch/api';
import { useCustomers } from '@fetch/api/admin';
import { formatPhPhone } from '@fetch/core';

import { Shell } from '@/components/Shell';
import { Badge, Card, PageHeader, Td, Th, inputClass, manilaTime } from '@/components/ui';

export default function CustomersPage() {
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setSearch(input), 300);
    return () => clearTimeout(t);
  }, [input]);

  const { data: rows, isLoading, error } = useCustomers(search);

  return (
    <Shell>
      <div className="flex flex-col gap-5">
        <PageHeader
          title="Customers"
          subtitle="Everyone with an account. Riders and staff appear here too, tagged by role."
        />

        <input
          className={`${inputClass} max-w-sm`}
          placeholder="Search name or phone"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />

        <Card>
          {isLoading ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : error ? (
            <p className="text-sm text-bad">{humanizeError(error)}</p>
          ) : (rows ?? []).length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">Nobody matches.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] text-sm">
                <thead className="border-b border-line">
                  <tr>
                    <Th>Name</Th>
                    <Th>Phone</Th>
                    <Th>Role</Th>
                    <Th right>Completed</Th>
                    <Th right>Cancelled</Th>
                    <Th>Last booking</Th>
                    <Th>Joined</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {(rows ?? []).map((c) => (
                    <tr key={c.id} className="hover:bg-raised/40">
                      <Td>
                        <Link href={`/customers/${c.id}`} className="font-semibold hover:underline">
                          {c.full_name || 'Unnamed'}
                        </Link>
                        {c.is_blocked ? (
                          <span className="ml-2">
                            <Badge tone="danger">blocked</Badge>
                          </span>
                        ) : null}
                      </Td>
                      <Td>
                        <a className="text-info hover:underline" href={`tel:${c.phone}`}>
                          {formatPhPhone(c.phone)}
                        </a>
                      </Td>
                      <Td>
                        <Badge tone={c.role === 'customer' ? 'neutral' : 'progress'}>{c.role}</Badge>
                      </Td>
                      <Td right>{c.completed_jobs}</Td>
                      <Td right className={c.cancelled_jobs > 2 ? 'text-bad' : ''}>
                        {c.cancelled_jobs}
                      </Td>
                      <Td className="text-muted">{manilaTime(c.last_booking_at)}</Td>
                      <Td className="text-muted">{manilaTime(c.created_at)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </Shell>
  );
}
