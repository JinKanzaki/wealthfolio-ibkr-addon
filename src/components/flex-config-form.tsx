import React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  Button,
  Input,
  Label,
  Switch,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@wealthfolio/ui";
import { Loader2 } from "lucide-react";
import type { FlexQueryConfig } from "../lib/flex-config-storage";
import { AccountGroupSuggestions } from "./account-group-suggestions";

// Validation schema
const flexConfigSchema = z.object({
  name: z.string().min(1, "Name is required").max(100, "Name too long"),
  queryId: z
    .string()
    .min(1, "Query ID is required")
    .regex(/^\d+$/, "Query ID must be numeric"),
  accountGroup: z.string().min(1, "Account group is required"),
  autoFetchEnabled: z.boolean(),
});

type FlexConfigFormData = z.infer<typeof flexConfigSchema>;

interface FlexConfigFormProps {
  defaultValues?: Partial<FlexQueryConfig>;
  existingGroups: string[];
  onSubmit: (data: FlexConfigFormData) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
}

export const FlexConfigForm: React.FC<FlexConfigFormProps> = ({
  defaultValues,
  existingGroups,
  onSubmit,
  onCancel,
  isSubmitting = false,
}) => {
  const isEditing = !!defaultValues?.id;

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FlexConfigFormData>({
    resolver: zodResolver(flexConfigSchema),
    defaultValues: {
      name: defaultValues?.name || "",
      queryId: defaultValues?.queryId || "",
      accountGroup: defaultValues?.accountGroup || "",
      autoFetchEnabled: defaultValues?.autoFetchEnabled ?? false,
    },
  });

  const autoFetchEnabled = watch("autoFetchEnabled");

  return (
    <div>
      <DialogHeader>
        <DialogTitle>
          {isEditing ? "Edit Flex Query Configuration" : "Add Flex Query Configuration"}
        </DialogTitle>
        <DialogDescription>
          Configure a Flex Query to fetch transactions for a specific account group.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-4">
        {/* Name */}
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            placeholder="e.g., Main Account, ISA"
            {...register("name")}
          />
          {errors.name && (
            <p className="text-sm text-destructive">{errors.name.message}</p>
          )}
        </div>

        {/* Query ID */}
        <div className="space-y-2">
          <Label htmlFor="queryId">Query ID</Label>
          <Input
            id="queryId"
            placeholder="e.g., 123456"
            {...register("queryId")}
          />
          {errors.queryId && (
            <p className="text-sm text-destructive">{errors.queryId.message}</p>
          )}
          <p className="text-xs text-muted-foreground">
            Find this in IBKR Client Portal → Reporting → Flex Queries
          </p>
        </div>

        {/* Account Group */}
        <div className="space-y-2">
          <Label htmlFor="accountGroup">Account Group</Label>
          <Input
            id="accountGroup"
            placeholder="e.g., IBKR Main"
            {...register("accountGroup")}
          />
          {errors.accountGroup && (
            <p className="text-sm text-destructive">{errors.accountGroup.message}</p>
          )}
          <AccountGroupSuggestions
            groups={existingGroups}
            currentValue={watch("accountGroup")}
            onSelect={(group) => setValue("accountGroup", group)}
          />
          <p className="text-xs text-muted-foreground">
            Transactions will be imported to accounts in this group (e.g., "{watch("accountGroup") || "Group"} - USD")
          </p>
        </div>

        {/* Auto-fetch Toggle */}
        <div className="flex items-center justify-between rounded-lg border p-3">
          <div className="space-y-0.5">
            <Label htmlFor="autoFetch">Enable auto-fetch</Label>
            <p className="text-xs text-muted-foreground">
              Automatically fetch and import when portfolio updates (max once per 6 hours)
            </p>
          </div>
          <Switch
            id="autoFetch"
            checked={autoFetchEnabled}
            onCheckedChange={(checked) => setValue("autoFetchEnabled", checked)}
          />
        </div>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="button" onClick={handleSubmit(onSubmit)} disabled={isSubmitting}>
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : isEditing ? (
            "Save Changes"
          ) : (
            "Add Configuration"
          )}
        </Button>
      </DialogFooter>
    </div>
  );
};
